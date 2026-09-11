import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AppRecord } from './apps.js';
import { AppStore } from './apps.js';

const inspectionFiles = [
  'halfcloud.md',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'README',
  'README.md',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'composer.json',
  'Gemfile',
  'go.mod',
  'Cargo.toml',
  '.env.example',
  '.env.sample',
  'example.env',
] as const;

const skippedTreeDirectories = new Set(['.git', 'node_modules', 'vendor', '.next', '.nuxt', 'dist', 'build', 'target', '__pycache__']);
const maxInspectionFileBytes = 64 * 1024;
const maxInspectionTotalBytes = 192 * 1024;
const maxReadBytes = 128 * 1024;
const maxTreeEntries = 250;
const maxBuildFiles = 20_000;
const maxBuildBytes = 1024 * 1024 * 1024;
const maxRecipeJsonBytes = 8 * 1024 * 1024;
const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:2::', 48], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as Array<[string, number]>) blockedAddresses.addSubnet(network, prefix, 'ipv6');

export type RepositoryDeploymentStage = NonNullable<AppRecord['deployment']>['stage'];

export interface RepositoryInspection {
  appId: string;
  source: NonNullable<AppRecord['source']>;
  tree: string;
  files: Array<{ path: string; content: string; truncated: boolean }>;
  limits: { treeDepth: number; treeEntries: number; fileBytes: number; totalBytes: number };
}

export interface RepositoryBuildRecipe {
  contextPath: string;
  dockerfilePath: string;
  dockerfileContent: string;
  dockerignoreContent: string;
}

export interface SavedRepositoryBuild {
  image: string;
  imageId: string;
  commit: string;
  recipe: RepositoryBuildRecipe;
}

export interface ServiceUpdateRecipe extends SavedRepositoryBuild {
  serviceId: string;
  healthPath: string | null;
}

export interface RepositoryUpdateRun {
  phase: 'applying' | 'committed';
  commit: string;
  previousUpdates: ServiceUpdateRecipe[];
  updates: ServiceUpdateRecipe[];
  repairingServiceIds?: string[];
}

export interface RepositoryBuildContext {
  context: string;
  dockerfile: string;
  entries: string[];
  image: string;
  commit: string;
  recipe: RepositoryBuildRecipe;
  cleanup?: () => Promise<void>;
}

const recipeContentSchema = z.string().refine((value) => Buffer.byteLength(value) <= maxReadBytes && !value.includes('\0'), 'Deployment file is too large or is not text');
const dockerfileContentSchema = recipeContentSchema.refine((value) => value.trim().length > 0, 'Dockerfile must not be empty');
const recipeSchema = z.object({
  contextPath: z.string().transform((value) => recipePath(value, true)),
  dockerfilePath: z.string().transform((value) => recipePath(value)),
  dockerfileContent: dockerfileContentSchema,
  dockerignoreContent: recipeContentSchema,
}).strict();
const savedBuildSchema = z.object({
  image: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9/@_.:-]*$/),
  imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  recipe: recipeSchema,
}).strict();
const serviceUpdatesSchema = z.array(savedBuildSchema.extend({
  serviceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  healthPath: z.string().max(500).regex(/^\/[^\x00-\x1f\x7f]*$/).nullable(),
}).strict()).max(100).refine((entries) => new Set(entries.map((entry) => entry.serviceId)).size === entries.length, 'Duplicate Service update recipe');
const servicePlanSchema = z.object({ version: z.literal(1), generation: z.uuid(), entries: serviceUpdatesSchema }).strict();
const legacyUpdateRunSchema = z.object({
  phase: z.enum(['applying', 'committed']),
  commit: savedBuildSchema.shape.commit,
  previousUpdates: serviceUpdatesSchema,
  updates: serviceUpdatesSchema,
}).strict();
const updateRunSchema = legacyUpdateRunSchema.extend({
  repairingServiceIds: z.array(serviceUpdatesSchema.element.shape.serviceId).max(100)
    .refine((entries) => new Set(entries).size === entries.length, 'Duplicate repairing Service ID').optional(),
}).strict().refine(({ phase, updates, repairingServiceIds }) => !repairingServiceIds
  || (phase === 'committed' && repairingServiceIds.every((serviceId) => updates.some((update) => update.serviceId === serviceId))),
'Only committed update Services may be repaired');
const updateRunFileSchema = z.union([
  z.object({ version: z.literal(1), run: legacyUpdateRunSchema }).strict(),
  z.object({ version: z.literal(2), run: updateRunSchema }).strict(),
]);

const githubEd25519HostKey = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

export type GitRepositoryErrorCode = 'invalid_url' | 'not_found' | 'not_public' | 'authentication_required' | 'host_verification_failed' | 'dns_failure' | 'network_failure' | 'clone_failed';

export interface RepositoryLocation {
  originalUrl: string;
  gitUrl: string;
  provider?: 'github';
  owner?: string;
  repository?: string;
  settingsUrl?: string;
  requiresSsh: boolean;
}

interface RepositoryMetadata {
  originalUrl: string;
  gitUrl: string;
  provider?: 'github';
  owner?: string;
  repository?: string;
  settingsUrl?: string;
  branch?: string;
  authentication: 'none' | 'ssh-deploy-key';
  accessVerified?: boolean;
}

export class GitRepositoryError extends Error {
  constructor(readonly code: GitRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'GitRepositoryError';
  }
}

export function validatePublicGitUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) throw new GitRepositoryError('invalid_url', 'Git repository URL must contain 1-2048 characters');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GitRepositoryError('invalid_url', 'Invalid Git repository URL');
  }
  if (url.protocol !== 'https:') throw new GitRepositoryError('invalid_url', 'Public Git repositories must use an HTTPS URL');
  if (url.username || url.password) throw new GitRepositoryError('invalid_url', 'Git repository URLs cannot contain credentials');
  if (!url.hostname || url.hostname.toLowerCase() === 'localhost') throw new GitRepositoryError('not_public', 'Git repository URL must use a public host');
  if (url.hash) throw new GitRepositoryError('invalid_url', 'Git repository URLs cannot contain fragments');
  return url.toString();
}

export function normalizeRepositoryUrl(value: string): RepositoryLocation {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) throw new GitRepositoryError('invalid_url', 'Git repository URL must contain 1-2048 characters');
  const scpMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)\/?$/.exec(trimmed);
  let url: URL;
  let requiresSsh = false;
  if (scpMatch) {
    requiresSsh = true;
    url = new URL(`https://github.com/${scpMatch[1]}/${scpMatch[2]}`);
  } else {
    try {
      url = new URL(trimmed);
    } catch {
      throw new GitRepositoryError('invalid_url', 'Invalid Git repository URL');
    }
    if (url.protocol === 'ssh:') {
      if (url.hostname.toLowerCase() !== 'github.com' || url.username !== 'git' || url.password || url.port) {
        throw new GitRepositoryError('invalid_url', 'SSH repository URLs must use git@github.com');
      }
      requiresSsh = true;
      url = new URL(`https://github.com${url.pathname}`);
    } else {
      validatePublicGitUrl(trimmed);
    }
  }
  if (url.search) throw new GitRepositoryError('invalid_url', 'Git repository URLs cannot contain query parameters');
  if (url.hostname.toLowerCase() !== 'github.com') {
    return { originalUrl: url.toString(), gitUrl: url.toString(), requiresSsh };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) throw new GitRepositoryError('invalid_url', 'GitHub repository URLs must include an owner and repository name');
  const owner = segments[0]!;
  const repository = segments[1]!.replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    throw new GitRepositoryError('invalid_url', 'Invalid GitHub repository owner or name');
  }
  const originalUrl = `https://github.com/${owner}/${repository}${url.pathname.toLowerCase().endsWith('.git') ? '.git' : ''}`;
  return {
    originalUrl,
    gitUrl: `git@github.com:${owner}/${repository}.git`,
    provider: 'github',
    owner,
    repository,
    settingsUrl: `https://github.com/${owner}/${repository}/settings/keys`,
    requiresSsh,
  };
}

function validateBranch(value: string | undefined) {
  if (value === undefined) return undefined;
  const branch = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.includes('@{') || branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) {
    throw new Error('Invalid Git branch name');
  }
  return branch;
}

function publicAddress(address: string) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return publicAddress(normalized.slice(7));
  if (net.isIPv4(address)) return !blockedAddresses.check(address, 'ipv4');
  if (net.isIPv6(address)) return !blockedAddresses.check(address, 'ipv6');
  return false;
}

function safeRelativePath(value: string, allowRoot = false) {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if ((allowRoot && (normalized === '' || normalized === '.'))) return '.';
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized) || normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Repository paths must be relative and cannot contain traversal');
  }
  return normalized;
}

function recipePath(value: string, allowRoot = false) {
  if (value.length > 1024 || /[\x00-\x1f\x7f:]/.test(value)) throw new Error('Invalid repository recipe path');
  const relative = safeRelativePath(value, allowRoot);
  if (relative.split('/').length > 64 || relative.split('/').some((part) => part.toLowerCase() === '.git' || isSensitiveBuildPath(part)) || (!allowRoot && relative.endsWith('.dockerignore'))) {
    throw new Error('Repository recipe path is excluded from the build context');
  }
  return relative;
}

function isSensitiveBuildPath(relativePath: string) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  if (basename === '.env.example' || basename === '.env.sample' || basename === 'example.env') return false;
  return basename === '.env' || basename.startsWith('.env.') || /\.(pem|key|p12|pfx)$/.test(basename)
    || ['.git-credentials', '.gitconfig', '.netrc', '.ssh', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].includes(basename);
}

function gitFailure(stderr: string) {
  const detail = stderr.trim().split('\n').slice(-3).join(' ').replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[credentials]@');
  if (/repository .* not found|not found/i.test(detail)) return new GitRepositoryError('not_found', 'Git repository was not found');
  if (/authentication failed|could not read username|permission denied|access denied/i.test(detail)) return new GitRepositoryError('not_public', 'Git repository is not publicly accessible');
  if (/host key verification failed|remote host identification has changed/i.test(detail)) return new GitRepositoryError('host_verification_failed', 'The Git host identity could not be verified');
  if (/could not resolve host|name or service not known/i.test(detail)) return new GitRepositoryError('dns_failure', 'Could not resolve the Git repository host');
  if (/could not connect|connection timed out|failed to connect|network is unreachable/i.test(detail)) return new GitRepositoryError('network_failure', 'Could not connect to the Git repository host');
  return new GitRepositoryError('clone_failed', detail ? `Git clone failed: ${detail.slice(0, 500)}` : 'Git clone failed');
}

async function directoryUsage(directory: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else {
        files += 1;
        if (entry.isFile()) bytes += (await stat(target)).size;
      }
      if (bytes > maxBuildBytes || files > maxBuildFiles) return;
    }
  };
  await visit(directory);
  return { bytes, files };
}

async function runGit(args: string[], cwd: string, timeoutMs = 120_000, limitedCheckout?: string, environment: NodeJS.ProcessEnv = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...environment,
      },
    });
    let stdout = '';
    let stderr = '';
    let limitError: Error | undefined;
    let checkingSize = false;
    const terminate = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall back to the direct process when the process group has already exited.
        }
      }
      child.kill('SIGKILL');
    };
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(-128 * 1024);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(terminate, timeoutMs);
    const sizeTimer = limitedCheckout ? setInterval(() => {
      if (checkingSize) return;
      checkingSize = true;
      void directoryUsage(limitedCheckout).then(({ bytes, files }) => {
        if (bytes > maxBuildBytes || files > maxBuildFiles) {
          limitError = new Error('Repository checkout exceeds HalfCloud safety limits');
          terminate();
        }
      }).catch((error) => {
        limitError = error instanceof Error ? error : new Error('Could not inspect repository checkout size');
        terminate();
      }).finally(() => { checkingSize = false; });
    }, 1_000) : undefined;
    sizeTimer?.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      if (sizeTimer) clearInterval(sizeTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (sizeTimer) clearInterval(sizeTimer);
      if (limitError) reject(limitError);
      else if (signal) reject(new GitRepositoryError('network_failure', 'Git operation timed out'));
      else if (code !== 0) reject(gitFailure(stderr));
      else resolve({ stdout, stderr });
    });
  });
}

async function runProcess(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH } });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4096); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${stderr.trim().slice(0, 500)}`)));
  });
}

export class RepositoryService {
  private readonly repositoriesDir: string;

  constructor(
    private readonly apps = new AppStore(),
    repositoriesDir = process.env.HALFCLOUD_REPOSITORIES_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/repositories`,
    private readonly resolveHost: (hostname: string) => Promise<Array<{ address: string }>> = async (hostname) => lookup(hostname, { all: true, verbatim: true }),
    private readonly git = runGit,
  ) {
    this.repositoriesDir = path.resolve(repositoriesDir);
  }

  async clone(appId: string, repositoryUrl: string, requestedBranch?: string) {
    const url = validatePublicGitUrl(repositoryUrl);
    const branch = validateBranch(requestedBranch);
    const parsed = new URL(url);
    const addresses = await this.resolveHost(parsed.hostname).catch(() => { throw new GitRepositoryError('dns_failure', 'Could not resolve the Git repository host'); });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new GitRepositoryError('not_public', 'Git repository URL must resolve only to public network addresses');
    const selectedAddress = addresses[0]!.address;
    const resolvedAddress = selectedAddress.includes(':') ? `[${selectedAddress}]` : selectedAddress;
    const resolvedPort = parsed.port || '443';

    const app = await this.apps.get(appId);
    const source = { type: 'git' as const, url, ...(branch ? { branch } : {}) };
    await this.apps.update(app.id, {
      source,
      deployment: { status: 'in_progress', stage: 'cloning', message: 'Cloning repository', buildAttempts: 0, updatedAt: new Date().toISOString() },
    });

    const appRoot = await this.appRoot(app.id, true);
    const checkout = path.join(appRoot, 'repository');
    try {
      await lstat(checkout);
      throw new Error('A repository checkout already exists for this App');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      const cloneArgs = [
        '-c', 'protocol.file.allow=never',
        '-c', 'protocol.ext.allow=never',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'http.followRedirects=false',
        '-c', `http.curloptResolve=${parsed.hostname}:${resolvedPort}:${resolvedAddress}`,
        'clone', '--depth=1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules',
        ...(branch ? ['--branch', branch, '--single-branch'] : []),
        url, 'repository',
      ];
      await runGit(cloneArgs, appRoot, 120_000, checkout);
      const checkoutUsage = await directoryUsage(checkout);
      if (checkoutUsage.bytes > maxBuildBytes || checkoutUsage.files > maxBuildFiles) throw new GitRepositoryError('clone_failed', 'Repository checkout exceeds HalfCloud safety limits');
      const [{ stdout: branchOutput }, { stdout: commitOutput }] = await Promise.all([
        runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkout),
        runGit(['rev-parse', 'HEAD'], checkout),
      ]);
      const resolvedBranch = branchOutput.trim();
      const resolvedCommit = commitOutput.trim().toLowerCase();
      if (!resolvedBranch || !/^[a-f0-9]{40}$/.test(resolvedCommit)) throw new Error('Git repository did not provide a branch and commit');
      const updated = await this.apps.update(app.id, {
        source: { type: 'git', url, branch: resolvedBranch, resolvedCommit },
        deployment: { status: 'in_progress', stage: 'inspecting', message: 'Inspecting repository', buildAttempts: 0, updatedAt: new Date().toISOString() },
      });
      await this.writeMetadata(app.id, { originalUrl: url, gitUrl: url, branch: resolvedBranch, authentication: 'none' });
      return { appId: app.id, appName: app.name, source: updated.source };
    } catch (error) {
      await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
      await this.fail(app.id, 'cloning', error);
      throw error;
    }
  }

  async preparePrivateAccess(appIdOrName: string, repositoryUrl?: string) {
    const app = await this.apps.get(appIdOrName);
    const location = normalizeRepositoryUrl(repositoryUrl ?? app.source?.url ?? '');
    if (location.provider !== 'github') throw new GitRepositoryError('authentication_required', 'Private repository setup currently supports GitHub repositories');
    const root = await this.appRoot(app.id, true);
    const privateKey = path.join(root, 'id_ed25519');
    const publicKey = `${privateKey}.pub`;
    const keyPairExists = await Promise.all([privateKey, publicKey].map(async (file) => {
      try {
        return (await lstat(file)).isFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }));
    if (!keyPairExists.every(Boolean)) {
      await Promise.all([rm(privateKey, { force: true }), rm(publicKey, { force: true })]);
      await runProcess('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `halfcloud:${app.id}`, '-f', privateKey], root);
    }
    await chmod(privateKey, 0o600);
    await chmod(publicKey, 0o644);
    const publicKeyValue = (await readFile(publicKey, 'utf8')).trim();
    if (!publicKeyValue.startsWith('ssh-ed25519 ')) throw new Error('HalfCloud could not generate an SSH deploy key');
    await writeFile(path.join(root, 'known_hosts'), `${githubEd25519HostKey}\n`, { mode: 0o600 });
    await this.writeMetadata(app.id, { ...location, authentication: 'ssh-deploy-key', accessVerified: false });
    const source = {
      type: 'git' as const,
      url: location.originalUrl,
      gitUrl: location.gitUrl,
      provider: location.provider,
      owner: location.owner,
      repository: location.repository,
      settingsUrl: location.settingsUrl,
      authentication: 'ssh-deploy-key' as const,
      ...(app.source?.branch ? { branch: app.source.branch } : {}),
    };
    await this.apps.update(app.id, {
      source,
      deployment: { status: 'in_progress', stage: 'awaiting_deploy_key', message: 'Waiting for the GitHub deploy key', buildAttempts: 0, updatedAt: new Date().toISOString() },
    });
    return this.publicSetup(app.id, publicKeyValue, location, 'pending');
  }

  async getPrivateAccessSetup(appIdOrName: string) {
    const app = await this.gitApp(appIdOrName);
    if (app.source?.authentication !== 'ssh-deploy-key') throw new Error('This App does not use an SSH deploy key');
    const root = await this.appRoot(app.id);
    const publicKey = (await readFile(path.join(root, 'id_ed25519.pub'), 'utf8')).trim();
    const metadata = await this.readMetadata(app.id);
    return this.publicSetup(app.id, publicKey, normalizeRepositoryUrl(metadata.originalUrl), metadata.accessVerified ? 'verified' : 'pending');
  }

  async verifyPrivateAccess(appIdOrName: string) {
    const app = await this.gitApp(appIdOrName);
    const metadata = await this.privateMetadata(app.id);
    try {
      const { stdout } = await this.runPrivateGit(app.id, ['ls-remote', '--symref', metadata.gitUrl, 'HEAD']);
      const branch = stdout.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1];
      await this.writeMetadata(app.id, { ...metadata, ...(branch ? { branch } : {}), accessVerified: true });
      return { ...this.publicSetup(app.id, undefined, normalizeRepositoryUrl(metadata.originalUrl), 'verified'), ...(branch ? { branch } : {}) };
    } catch (error) {
      if (error instanceof GitRepositoryError && error.code === 'host_verification_failed') throw error;
      throw new GitRepositoryError('authentication_required', `HalfCloud still cannot access ${metadata.owner}/${metadata.repository} using this deploy key`);
    }
  }

  async clonePrivate(appIdOrName: string, requestedBranch?: string) {
    const app = await this.gitApp(appIdOrName);
    const metadata = await this.privateMetadata(app.id);
    if (!metadata.accessVerified) throw new GitRepositoryError('authentication_required', 'Verify the GitHub deploy key before cloning this repository');
    const branch = validateBranch(requestedBranch ?? app.source?.branch ?? metadata.branch);
    const root = await this.appRoot(app.id);
    const checkout = path.join(root, 'repository');
    try {
      await lstat(checkout);
      try {
        const [{ stdout: branchOutput }, { stdout: commitOutput }] = await Promise.all([
          runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkout),
          runGit(['rev-parse', 'HEAD'], checkout),
        ]);
        const resolvedBranch = branchOutput.trim();
        const resolvedCommit = commitOutput.trim().toLowerCase();
        if (!resolvedBranch || !/^[a-f0-9]{40}$/.test(resolvedCommit)) throw new Error('Incomplete repository checkout');
        const source = { ...app.source!, branch: resolvedBranch, resolvedCommit };
        const updated = await this.apps.update(app.id, {
          source,
          deployment: { status: 'in_progress', stage: 'inspecting', message: 'Inspecting repository', buildAttempts: 0, updatedAt: new Date().toISOString() },
        });
        await this.writeMetadata(app.id, { ...metadata, branch: resolvedBranch, accessVerified: true });
        return { appId: app.id, appName: app.name, source: updated.source, existing: true };
      } catch {
        await rm(checkout, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.setStage(app.id, 'cloning', 'Cloning private repository');
    try {
      await this.runPrivateGit(app.id, [
        '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null',
        'clone', '--depth=1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules',
        ...(branch ? ['--branch', branch, '--single-branch'] : []), metadata.gitUrl, 'repository',
      ], root, checkout);
      const checkoutUsage = await directoryUsage(checkout);
      if (checkoutUsage.bytes > maxBuildBytes || checkoutUsage.files > maxBuildFiles) throw new GitRepositoryError('clone_failed', 'Repository checkout exceeds HalfCloud safety limits');
      const [{ stdout: branchOutput }, { stdout: commitOutput }] = await Promise.all([
        runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkout),
        runGit(['rev-parse', 'HEAD'], checkout),
      ]);
      const resolvedBranch = branchOutput.trim();
      const resolvedCommit = commitOutput.trim().toLowerCase();
      if (!resolvedBranch || !/^[a-f0-9]{40}$/.test(resolvedCommit)) throw new Error('Git repository did not provide a branch and commit');
      const source = { ...app.source!, branch: resolvedBranch, resolvedCommit };
      const updated = await this.apps.update(app.id, {
        source,
        deployment: { status: 'in_progress', stage: 'inspecting', message: 'Inspecting repository', buildAttempts: 0, updatedAt: new Date().toISOString() },
      });
      await this.writeMetadata(app.id, { ...metadata, branch: resolvedBranch, accessVerified: true });
      return { appId: app.id, appName: app.name, source: updated.source };
    } catch (error) {
      await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
      await this.fail(app.id, 'cloning', error);
      throw error;
    }
  }

  async refresh(appIdOrName: string) {
    const app = await this.gitApp(appIdOrName);
    const branch = validateBranch(app.source!.branch);
    if (!branch || !app.source!.resolvedCommit) throw new Error('Clone the repository before refreshing it');
    const checkout = await this.checkout(app.id);
    const privateAccess = app.source!.authentication === 'ssh-deploy-key';
    const url = privateAccess
      ? normalizeRepositoryUrl((await this.privateMetadata(app.id)).originalUrl).gitUrl
      : validatePublicGitUrl(app.source!.url);
    const options = [
      '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'core.hooksPath=/dev/null', '-c', 'http.followRedirects=false',
      '-c', `remote.origin.url=${url}`,
    ];
    if (!privateAccess) {
      const parsed = new URL(url);
      const addresses = await this.resolveHost(parsed.hostname).catch(() => { throw new GitRepositoryError('dns_failure', 'Could not resolve the Git repository host'); });
      if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new GitRepositoryError('not_public', 'Git repository URL must resolve only to public network addresses');
      const address = addresses[0]!.address;
      options.push('-c', `http.curloptResolve=${parsed.hostname}:${parsed.port || '443'}:${address.includes(':') ? `[${address}]` : address}`);
    }
    const git = (args: string[]) => privateAccess
      ? this.runPrivateGit(app.id, [...options, ...args], checkout, checkout)
      : this.git([...options, ...args], checkout, 120_000, checkout);
    await git(['fetch', '--depth=1', '--no-filter', '--no-tags', '--no-recurse-submodules', url, `refs/heads/${branch}`]);
    const { stdout } = await git(['rev-parse', 'FETCH_HEAD']);
    const resolvedCommit = stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(resolvedCommit)) throw new Error('Git repository did not provide a commit');
    const usage = await directoryUsage(checkout);
    if (usage.bytes > maxBuildBytes || usage.files > maxBuildFiles) throw new Error('Repository checkout exceeds HalfCloud safety limits');
    // Do not reset or clean: retain generated build files and refuse conflicting local edits.
    await git(['checkout', '--no-overwrite-ignore', '--no-recurse-submodules', '-B', branch, resolvedCommit]);
    const changed = resolvedCommit !== app.source!.resolvedCommit;
    const updated = changed ? await this.apps.update(app.id, {
      source: { ...app.source!, resolvedCommit },
      deployment: { status: 'in_progress', stage: 'inspecting', message: 'Refreshed repository', buildAttempts: 0, updatedAt: new Date().toISOString() },
    }) : app;
    return { appId: app.id, appName: app.name, source: updated.source, changed };
  }

  async inspect(appIdOrName: string): Promise<RepositoryInspection> {
    const app = await this.gitApp(appIdOrName);
    await this.setStage(app.id, 'inspecting', 'Inspecting repository');
    const checkout = await this.checkout(app.id);
    const entries = await readdir(checkout, { withFileTypes: true });
    const byLowerName = new Map(entries.filter((entry) => entry.isFile()).map((entry) => [entry.name.toLowerCase(), entry.name]));
    let remaining = maxInspectionTotalBytes;
    const files: RepositoryInspection['files'] = [];
    for (const requested of inspectionFiles) {
      const actual = byLowerName.get(requested.toLowerCase());
      if (!actual || files.some((file) => file.path === actual) || remaining <= 0) continue;
      const result = await this.readText(checkout, actual, Math.min(maxInspectionFileBytes, remaining));
      files.push({ path: actual, content: result.content, truncated: result.truncated });
      remaining -= Buffer.byteLength(result.content);
    }
    const tree = await this.tree(checkout, 3, maxTreeEntries);
    await this.setStage(app.id, 'planning', 'Planning deployment');
    return {
      appId: app.id,
      source: app.source!,
      tree,
      files,
      limits: { treeDepth: 3, treeEntries: maxTreeEntries, fileBytes: maxInspectionFileBytes, totalBytes: maxInspectionTotalBytes },
    };
  }

  async listDirectory(appIdOrName: string, repositoryPath = '.') {
    const app = await this.gitApp(appIdOrName);
    const checkout = await this.checkout(app.id);
    const relative = safeRelativePath(repositoryPath, true);
    const target = await this.existingPath(checkout, relative);
    if (!(await stat(target)).isDirectory()) throw new Error(`${relative} is not a repository directory`);
    const entries = (await readdir(target, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    return {
      path: relative,
      entries: entries.slice(0, 250).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' })),
      truncated: entries.length > 250,
    };
  }

  async readFile(appIdOrName: string, repositoryPath: string) {
    const app = await this.gitApp(appIdOrName);
    const checkout = await this.checkout(app.id);
    const relative = safeRelativePath(repositoryPath);
    if (isSensitiveBuildPath(relative)) throw new Error('Secret-bearing environment and key files cannot be read by the deployment agent');
    return { path: relative, ...(await this.readText(checkout, relative, maxReadBytes)) };
  }

  async writeDeploymentFile(appIdOrName: string, repositoryPath: string, content: string) {
    const app = await this.gitApp(appIdOrName);
    const checkout = await this.checkout(app.id);
    const relative = safeRelativePath(repositoryPath);
    const basename = path.posix.basename(relative);
    if (!(basename === '.dockerignore' || /^Dockerfile(?:\.[A-Za-z0-9._-]+)?$/.test(basename))) {
      throw new Error('The deployment agent may write only Dockerfile variants and .dockerignore files');
    }
    (basename === '.dockerignore' || basename.endsWith('.dockerignore') ? recipeContentSchema : dockerfileContentSchema).parse(content);
    const parent = await this.existingPath(checkout, path.posix.dirname(relative));
    if (!(await stat(parent)).isDirectory()) throw new Error('Deployment file parent must be an existing repository directory');
    const destination = path.join(parent, basename);
    try {
      if ((await lstat(destination)).isSymbolicLink()) throw new Error('Deployment files cannot replace symbolic links');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, destination);
    await this.setStage(app.id, 'preparing', `Prepared ${relative}`);
    return { appId: app.id, path: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') };
  }

  async prepareGeneratedBuildContext(appIdOrName: string, contextPath: string, dockerfileContent: string, dockerignoreContent: string) {
    // Validate both inputs before changing either existing deployment file.
    dockerfileContentSchema.parse(dockerfileContent);
    recipeContentSchema.parse(dockerignoreContent);
    const app = await this.gitApp(appIdOrName);
    const checkout = await this.checkout(app.id);
    const contextRelative = recipePath(contextPath, true);
    const context = await this.existingPath(checkout, contextRelative);
    if (!(await stat(context)).isDirectory()) throw new Error('Docker build context must be a repository directory');
    const repositoryPrefix = contextRelative === '.' ? '' : `${contextRelative}/`;
    await this.writeDeploymentFile(app.id, `${repositoryPrefix}Dockerfile.halfcloud`, dockerfileContent);
    await this.writeDeploymentFile(app.id, `${repositoryPrefix}.dockerignore`, dockerignoreContent);
    return this.buildContext(app.id, contextRelative, 'Dockerfile.halfcloud');
  }

  async buildContext(appIdOrName: string, contextPath = '.', dockerfilePath = 'Dockerfile'): Promise<RepositoryBuildContext> {
    const app = await this.gitApp(appIdOrName);
    if (!app.source?.resolvedCommit) throw new Error('Repository does not have a resolved commit');
    const checkout = await this.checkout(app.id);
    const contextRelative = recipePath(contextPath, true);
    const context = await this.existingPath(checkout, contextRelative);
    if (!(await stat(context)).isDirectory()) throw new Error('Docker build context must be a repository directory');
    const dockerfileRelative = recipePath(dockerfilePath);
    const dockerfile = await this.existingPath(context, dockerfileRelative);
    if (!(await stat(dockerfile)).isFile()) throw new Error('Dockerfile path must identify a regular file inside the build context');
    const dockerfileContent = await this.readRecipeText(context, dockerfileRelative);
    let dockerignoreContent = '';
    for (const ignorePath of [`${dockerfileRelative}.dockerignore`, '.dockerignore']) {
      // A dangling symlink is not an absent ignore file and must not trigger fallback.
      try {
        await lstat(path.join(context, ignorePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      dockerignoreContent = await this.readRecipeText(context, ignorePath);
      break;
    }
    const recipe = recipeSchema.parse({ contextPath: contextRelative, dockerfilePath: dockerfileRelative, dockerfileContent, dockerignoreContent });
    const attempts = (app.deployment?.buildAttempts ?? 0) + 1;
    if (attempts > 3) throw new Error('Build retry limit reached; inspect the last failure before starting a new deployment');
    const build = await this.prepareSavedBuild(app.id, recipe);
    try {
      await this.setStage(app.id, 'building', `Building application (attempt ${attempts} of 3)`, { buildAttempts: attempts, image: undefined });
      return build;
    } catch (error) {
      await build.cleanup?.();
      throw error;
    }
  }

  async recordBuild(appId: string, build: RepositoryBuildContext, imageId: string): Promise<void> {
    const saved = savedBuildSchema.parse({ image: build.image, imageId, commit: build.commit, recipe: build.recipe });
    const app = await this.gitApp(appId);
    const root = await this.appRoot(app.id, true);
    const file = `build-${createHash('sha256').update(saved.image).digest('hex')}.json`;
    await this.writeRecipeJson(root, file, { version: 1, build: saved }, true);
  }

  async getBuild(appId: string, image: string): Promise<SavedRepositoryBuild | undefined> {
    const app = await this.gitApp(appId);
    savedBuildSchema.shape.image.parse(image);
    const root = await this.appRoot(app.id, true);
    const value = await this.readRecipeJson(root, `build-${createHash('sha256').update(image).digest('hex')}.json`);
    if (value === undefined) return undefined;
    const saved = z.object({ version: z.literal(1), build: savedBuildSchema }).strict().parse(value).build;
    if (saved.image !== image) throw new Error('Saved build image does not match its storage key');
    return saved;
  }

  async getServiceUpdates(appId: string): Promise<ServiceUpdateRecipe[]> {
    const app = await this.gitApp(appId);
    const root = await this.appRoot(app.id, true);
    const value = await this.readRecipeJson(root, 'service-updates.json');
    if (value === undefined) return [];
    const plan = servicePlanSchema.parse(value);
    for (const entry of plan.entries) {
      const directory = `service-updates-${plan.generation}/${entry.serviceId}`;
      const dockerfile = await this.readRecipeText(root, `${directory}/Dockerfile.update`);
      const ignore = await this.readRecipeText(root, `${directory}/.dockerignore`);
      if (dockerfile !== entry.recipe.dockerfileContent || ignore !== entry.recipe.dockerignoreContent) throw new Error('Saved Service recipe files do not match the update plan');
    }
    return plan.entries;
  }

  async saveServiceUpdates(appId: string, entries: ServiceUpdateRecipe[]): Promise<void> {
    const plan = servicePlanSchema.parse({ version: 1, generation: randomUUID(), entries });
    if (Buffer.byteLength(JSON.stringify(plan)) > maxRecipeJsonBytes) throw new Error('Saved repository recipes exceed safety limits');
    const app = await this.gitApp(appId);
    const root = await this.appRoot(app.id, true);
    const directory = path.join(root, `service-updates-${plan.generation}`);
    await mkdir(directory, { mode: 0o700 });
    for (const entry of plan.entries) {
      const serviceDirectory = path.join(directory, entry.serviceId);
      await mkdir(serviceDirectory, { mode: 0o700 });
      await writeFile(path.join(serviceDirectory, 'Dockerfile.update'), entry.recipe.dockerfileContent, { mode: 0o600, flag: 'wx', flush: true });
      await writeFile(path.join(serviceDirectory, '.dockerignore'), entry.recipe.dockerignoreContent, { mode: 0o600, flag: 'wx', flush: true });
      await this.syncRecipeDirectory(serviceDirectory);
    }
    await this.syncRecipeDirectory(directory);
    // Retain generations even on failure: rename may publish the plan before directory sync throws.
    await this.writeRecipeJson(root, 'service-updates.json', plan, true);
  }

  async getUpdateRun(appId: string): Promise<RepositoryUpdateRun | undefined> {
    const app = await this.gitApp(appId);
    const root = await this.appRoot(app.id).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!root) return undefined;
    const value = await this.readRecipeJson(root, 'update-run.json');
    return value === undefined ? undefined : updateRunFileSchema.parse(value).run;
  }

  async saveUpdateRun(appId: string, run: RepositoryUpdateRun): Promise<void> {
    const value = updateRunFileSchema.parse({ version: 2, run });
    const app = await this.gitApp(appId);
    await this.writeRecipeJson(await this.appRoot(app.id, true), 'update-run.json', value, true);
  }

  async clearUpdateRun(appId: string): Promise<void> {
    const app = await this.gitApp(appId);
    const root = await this.appRoot(app.id).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!root) return;
    await rm(path.join(root, 'update-run.json'), { force: true });
    await this.syncRecipeDirectory(root);
  }

  async prepareSavedBuild(appId: string, input: RepositoryBuildRecipe): Promise<RepositoryBuildContext> {
    const recipe = recipeSchema.parse(input);
    const app = await this.gitApp(appId);
    if (!app.source?.resolvedCommit) throw new Error('Repository does not have a resolved commit');
    const checkout = await this.checkout(app.id);
    const source = await this.existingPath(checkout, recipe.contextPath);
    if (!(await stat(source)).isDirectory()) throw new Error('Docker build context must be a repository directory');
    const staging = await mkdtemp(path.join(await this.appRoot(app.id), 'build-context-'));
    const cleanup = () => rm(staging, { recursive: true, force: true });
    try {
      const context = path.join(staging, 'repository', recipe.contextPath);
      await mkdir(context, { recursive: true, mode: 0o700 });
      const entries = await this.collectBuildFiles(source, { context, recipe });
      await mkdir(path.dirname(path.join(context, recipe.dockerfilePath)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(context, recipe.dockerfilePath), recipe.dockerfileContent, { mode: 0o600, flag: 'wx' });
      await writeFile(path.join(context, '.dockerignore'), recipe.dockerignoreContent, { mode: 0o600, flag: 'wx' });
      entries.push(recipe.dockerfilePath, '.dockerignore');
      const image = `halfcloud/app-${app.id.slice(4).replaceAll('-', '')}:${app.source.resolvedCommit.slice(0, 12)}-${randomUUID()}`;
      // Updates have one caller-controlled attempt per Service, independent of initial AI build retries.
      await this.setStage(app.id, 'building', 'Building application from saved recipe');
      return { context, dockerfile: recipe.dockerfilePath, entries: entries.sort(), image, commit: app.source.resolvedCommit, recipe, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async buildSucceeded(appIdOrName: string, image: string) {
    const app = await this.gitApp(appIdOrName);
    return this.setStage(app.id, 'deploying', 'Deploying application services', { image, buildAttempts: 0 });
  }

  async retryBuild(appIdOrName: string) {
    const app = await this.gitApp(appIdOrName);
    if (app.deployment?.status !== 'failed' || app.deployment.errorCode !== 'build_failed' || (app.deployment.buildAttempts ?? 0) < 3) {
      throw new Error('Another build cycle is available only after three failed build attempts');
    }
    return this.setStage(app.id, 'preparing', 'Preparing another build cycle', { buildAttempts: 0, image: undefined });
  }

  async fail(appIdOrName: string, failedStage: RepositoryDeploymentStage, error: unknown) {
    const app = await this.apps.get(appIdOrName);
    const message = error instanceof Error ? error.message : 'Deployment failed';
    const errorCode = error instanceof GitRepositoryError ? error.code
      : failedStage === 'inspecting' ? 'inspection_failed'
        : failedStage === 'building' ? 'build_failed'
          : failedStage === 'deploying' ? 'deployment_failed'
            : failedStage === 'initializing' ? 'initialization_failed'
              : failedStage === 'verifying' ? 'verification_failed'
                : 'clone_failed';
    return this.apps.update(app.id, {
      source: app.source,
      deployment: { ...app.deployment, status: 'failed', stage: 'failed', message: `${failedStage}: ${message}`.slice(0, 500), errorCode, updatedAt: new Date().toISOString() },
    });
  }

  async setStage(appIdOrName: string, stage: RepositoryDeploymentStage, message: string, changes: Partial<NonNullable<AppRecord['deployment']>> = {}) {
    const app = await this.apps.get(appIdOrName);
    return this.apps.update(app.id, {
      source: app.source,
      deployment: { ...app.deployment, ...changes, status: stage === 'running' ? 'running' : stage === 'failed' ? 'failed' : 'in_progress', stage, message, errorCode: undefined, updatedAt: new Date().toISOString() },
    });
  }

  async markDeployed(appIdOrName: string) {
    const app = await this.gitApp(appIdOrName);
    if (!app.source?.resolvedCommit) throw new Error('Repository does not have a resolved commit');
    return this.apps.update(app.id, {
      source: { ...app.source, currentCommit: app.source.resolvedCommit },
      deployment: { ...app.deployment, status: 'running', stage: 'running', message: 'Deployment complete', updatedAt: new Date().toISOString() },
    });
  }

  async delete(appId: string) {
    const appRoot = path.join(this.repositoriesDir, appId);
    if (appRoot.startsWith(`${this.repositoriesDir}${path.sep}`)) await rm(appRoot, { recursive: true, force: true });
  }

  private async readRecipeText(root: string, relative: string, limit = maxReadBytes) {
    const result = await this.readText(root, relative, limit);
    if (result.truncated) throw new Error('Saved repository recipe exceeds safety limits');
    return result.content;
  }

  private async readRecipeJson(root: string, file: string): Promise<unknown> {
    try {
      await lstat(path.join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(await this.readRecipeText(root, file, maxRecipeJsonBytes));
  }

  private async writeRecipeJson(root: string, file: string, value: unknown, durable = false) {
    const content = JSON.stringify(value);
    if (Buffer.byteLength(content) > maxRecipeJsonBytes) throw new Error('Saved repository recipes exceed safety limits');
    const temporary = path.join(root, `${file}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx', flush: durable });
      await rename(temporary, path.join(root, file));
      if (durable) await this.syncRecipeDirectory(root);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async syncRecipeDirectory(root: string) {
    const directory = await open(root, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async collectBuildFiles(context: string, staging: { context: string; recipe: RepositoryBuildRecipe }) {
    const entries: string[] = [];
    let count = 2;
    let bytes = Buffer.byteLength(staging.recipe.dockerfileContent) + Buffer.byteLength(staging.recipe.dockerignoreContent);
    const buffer = Buffer.alloc(64 * 1024);
    const checkLimits = () => {
      if (count > maxBuildFiles || bytes > maxBuildBytes) throw new Error('Repository build context exceeds HalfCloud safety limits');
    };
    const collect = async (directory: string, prefix = '', depth = 0): Promise<void> => {
      if (depth > 64) throw new Error('Repository build context exceeds HalfCloud safety limits');
      for await (const entry of await opendir(directory)) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        count += 1;
        checkLimits();
        if (entry.name.toLowerCase() === '.git' || isSensitiveBuildPath(relative)) continue;
        // Dockerfile-specific ignore files override the root ignore, even for nested Dockerfiles.
        if (entry.name.endsWith('.dockerignore') || relative === staging.recipe.dockerfilePath) continue;
        if (relative.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(relative)) throw new Error('Invalid repository build path');
        const absolute = path.join(directory, entry.name);
        const details = await lstat(absolute);
        if (details.isSymbolicLink()) throw new Error('Repository build contexts cannot contain symbolic links');
        if (details.isDirectory()) {
          await this.existingPath(context, relative);
          await mkdir(path.join(staging.context, relative), { mode: 0o700 });
          await collect(absolute, relative, depth + 1);
        } else {
          if (!details.isFile()) throw new Error('Repository build contexts must contain only regular files');
          if (bytes + details.size > maxBuildBytes) throw new Error('Repository build context exceeds HalfCloud safety limits');
          entries.push(relative);
          const source = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            if (!(await source.stat()).isFile()) throw new Error('Repository build contexts must contain only regular files');
            const target = await open(path.join(staging.context, relative), 'wx', details.mode & 0o777);
            try {
              for (;;) {
                const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                bytes += bytesRead;
                checkLimits();
                let offset = 0;
                while (offset < bytesRead) offset += (await target.write(buffer, offset, bytesRead - offset)).bytesWritten;
              }
            } finally {
              await target.close();
            }
          } finally {
            await source.close();
          }
        }
      }
    };
    await collect(context);
    return entries.sort();
  }

  private publicSetup(appId: string, publicKey: string | undefined, location: RepositoryLocation, status: 'pending' | 'verified') {
    return {
      appId,
      status,
      provider: location.provider,
      repository: `${location.owner}/${location.repository}`,
      settingsUrl: location.settingsUrl,
      ...(publicKey ? { publicKey } : {}),
      title: 'HalfCloud',
      allowWriteAccess: false,
    };
  }

  private async privateMetadata(appId: string) {
    const metadata = await this.readMetadata(appId);
    if (metadata.authentication !== 'ssh-deploy-key' || metadata.provider !== 'github') throw new Error('SSH deploy-key authentication is not configured for this App');
    return metadata;
  }

  private async readMetadata(appId: string): Promise<RepositoryMetadata> {
    return JSON.parse(await readFile(path.join(await this.appRoot(appId), 'metadata.json'), 'utf8')) as RepositoryMetadata;
  }

  private async writeMetadata(appId: string, metadata: RepositoryMetadata) {
    const root = await this.appRoot(appId, true);
    const destination = path.join(root, 'metadata.json');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  }

  private async runPrivateGit(appId: string, args: string[], cwd?: string, limitedCheckout?: string) {
    const root = await this.appRoot(appId);
    const metadata = await this.privateMetadata(appId);
    const addresses = await this.resolveHost('github.com').catch(() => { throw new GitRepositoryError('dns_failure', 'Could not resolve GitHub'); });
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new GitRepositoryError('not_public', 'GitHub must resolve only to public network addresses');
    const config = path.join(root, 'ssh_config');
    await writeFile(config, [
      'Host github.com', `  HostName ${addresses[0]!.address}`, '  HostKeyAlias github.com', '  User git',
      `  IdentityFile ${path.join(root, 'id_ed25519')}`, `  UserKnownHostsFile ${path.join(root, 'known_hosts')}`,
      '  IdentitiesOnly yes', '  BatchMode yes', '  PasswordAuthentication no', '  KbdInteractiveAuthentication no',
      '  StrictHostKeyChecking yes', '  ForwardAgent no', '  ClearAllForwardings yes', '',
    ].join('\n'), { mode: 0o600 });
    const quotedConfig = `'${config.replaceAll("'", "'\\''")}'`;
    return this.git(args, cwd ?? root, 120_000, limitedCheckout, { GIT_SSH_COMMAND: `ssh -F ${quotedConfig}`, GIT_SSH_VARIANT: 'ssh', SSH_AUTH_SOCK: '' });
  }

  private async gitApp(idOrName: string) {
    const app = await this.apps.get(idOrName);
    if (app.source?.type !== 'git') throw new Error(`App ${app.name} is not backed by a Git repository`);
    return app;
  }

  private async appRoot(appId: string, create = false) {
    await mkdir(this.repositoriesDir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.repositoriesDir);
    const target = path.join(root, appId);
    if (create) await mkdir(target, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const resolved = await realpath(target);
    if (resolved !== target || !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Repository storage path is not managed by HalfCloud');
    return resolved;
  }

  private async checkout(appId: string) {
    const appRoot = await this.appRoot(appId);
    const checkout = path.join(appRoot, 'repository');
    const resolved = await realpath(checkout);
    if (resolved !== checkout || !resolved.startsWith(`${appRoot}${path.sep}`)) throw new Error('Repository checkout is not managed by HalfCloud');
    return resolved;
  }

  private async existingPath(root: string, relativePath: string) {
    const relative = safeRelativePath(relativePath, true);
    const requested = relative === '.' ? root : path.join(root, ...relative.split('/'));
    const resolved = await realpath(requested);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('Repository path escapes the managed checkout');
    if (resolved !== requested) throw new Error('Repository paths cannot contain symbolic links');
    return resolved;
  }

  private async readText(root: string, relativePath: string, limit: number) {
    const target = await this.existingPath(root, relativePath);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new Error(`${relativePath} is not a repository file`);
      const buffer = Buffer.alloc(Math.min(details.size, limit + 1));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      const content = buffer.subarray(0, Math.min(bytesRead, limit));
      if (content.includes(0)) throw new Error(`${relativePath} is not a text file`);
      return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content, { stream: details.size > limit }), truncated: details.size > limit, bytes: details.size };
    } finally {
      await handle.close();
    }
  }

  private async tree(root: string, maxDepth: number, maxEntries: number) {
    const lines = ['/'];
    let count = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > maxDepth || count >= maxEntries) return;
      const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      for (const entry of entries) {
        if (count >= maxEntries) break;
        if (entry.isDirectory() && skippedTreeDirectories.has(entry.name)) continue;
        count += 1;
        lines.push(`${'  '.repeat(depth)}${entry.name}${entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''}`);
        if (entry.isDirectory()) await visit(path.join(directory, entry.name), depth + 1);
      }
    };
    await visit(root, 1);
    if (count >= maxEntries) lines.push('  ... tree truncated ...');
    return lines.join('\n');
  }
}
