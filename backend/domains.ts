import { resolve4, resolve6 } from 'node:dns/promises';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { z } from 'zod';

const hostnamePattern = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const domainSchema = z.object({
  hostname: z.string().regex(hostnamePattern),
  primary: z.boolean(),
  managed: z.boolean(),
});
const domainsSchema = z.array(domainSchema).min(1).refine((domains) => domains.filter((domain) => domain.primary).length === 1, 'Exactly one domain must be primary');

export type ServiceDomain = z.infer<typeof domainSchema>;
export type DomainState = ServiceDomain & {
  dnsConfigured: boolean;
  httpsReady: boolean;
  state: 'pending' | 'ready' | 'error';
  dnsTarget?: string;
};

export function normalizeHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!hostnamePattern.test(normalized)) throw new Error('Invalid domain hostname');
  return normalized;
}

export class DomainStore {
  readonly appsDir: string;
  private readonly serverAddress?: string;

  constructor(appsDir = process.env.HALFCLOUD_APPS_DIR ?? `${process.env.HOME ?? '/home/halfcloudrunner'}/.halfcloud/apps`) {
    this.appsDir = path.resolve(appsDir);
    this.serverAddress = this.addressFromBaseDomain(process.env.HALFCLOUD_BASE_DOMAIN);
  }

  async get(application: string, legacyHostname?: string): Promise<ServiceDomain[]> {
    try {
      return this.validate(JSON.parse(await readFile(this.filePath(application), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!legacyHostname) return [];
      const migrated = [{ hostname: normalizeHostname(legacyHostname), primary: true, managed: true }];
      await this.save(application, migrated);
      return migrated;
    }
  }

  async initialize(application: string, managedHostname: string, customHostname?: string) {
    const managed = normalizeHostname(managedHostname);
    const custom = customHostname ? normalizeHostname(customHostname) : undefined;
    const domains: ServiceDomain[] = custom && custom !== managed
      ? [{ hostname: custom, primary: true, managed: false }, { hostname: managed, primary: false, managed: true }]
      : [{ hostname: managed, primary: true, managed: true }];
    await this.save(application, domains);
    return domains;
  }

  async add(application: string, legacyHostname: string | undefined, hostname: string) {
    const domains = await this.get(application, legacyHostname);
    const normalized = normalizeHostname(hostname);
    if (domains.some((domain) => domain.hostname === normalized)) throw new Error(`${normalized} is already attached to ${application}`);
    const makePrimary = domains.every((domain) => domain.managed);
    const updated = [
      ...domains.map((domain) => ({ ...domain, primary: makePrimary ? false : domain.primary })),
      { hostname: normalized, primary: makePrimary, managed: false },
    ];
    await this.save(application, updated);
    return updated;
  }

  async remove(application: string, legacyHostname: string | undefined, hostname: string, allowManaged = false) {
    const domains = await this.get(application, legacyHostname);
    const normalized = normalizeHostname(hostname);
    const removed = domains.find((domain) => domain.hostname === normalized);
    if (!removed) throw new Error(`${normalized} is not attached to ${application}`);
    if (removed.managed && !allowManaged) throw new Error('Removing a HalfCloud-managed domain requires explicit confirmation');
    if (domains.length === 1) throw new Error('A public application must keep at least one domain');
    const remaining = domains.filter((domain) => domain.hostname !== normalized);
    if (removed.primary) {
      const nextPrimary = remaining.find((domain) => domain.managed) ?? remaining[0]!;
      for (const domain of remaining) domain.primary = domain === nextPrimary;
    }
    await this.save(application, remaining);
    return remaining;
  }

  async setPrimary(application: string, legacyHostname: string | undefined, hostname: string) {
    const domains = await this.get(application, legacyHostname);
    const normalized = normalizeHostname(hostname);
    if (!domains.some((domain) => domain.hostname === normalized)) throw new Error(`${normalized} is not attached to ${application}`);
    const updated = domains.map((domain) => ({ ...domain, primary: domain.hostname === normalized }));
    await this.save(application, updated);
    return updated;
  }

  async replace(application: string, domains: ServiceDomain[]) {
    await this.save(application, domains);
  }

  async withReadiness(domains: ServiceDomain[]): Promise<DomainState[]> {
    return Promise.all(domains.map(async (domain) => {
      if (!this.serverAddress) return { ...domain, dnsConfigured: false, httpsReady: false, state: 'error' as const };
      try {
        const addresses = await Promise.all([
          resolve4(domain.hostname).catch(() => []),
          resolve6(domain.hostname).catch(() => []),
        ]).then((results) => results.flat());
        const dnsConfigured = addresses.includes(this.serverAddress);
        const httpsReady = dnsConfigured ? await this.checkHttps(domain.hostname) : false;
        return {
          ...domain,
          dnsConfigured,
          httpsReady,
          state: httpsReady ? 'ready' as const : 'pending' as const,
          dnsTarget: this.serverAddress,
        };
      } catch {
        return { ...domain, dnsConfigured: false, httpsReady: false, state: 'error' as const, dnsTarget: this.serverAddress };
      }
    }));
  }

  private validate(value: unknown) {
    const domains = domainsSchema.parse(value).map((domain) => ({ ...domain, hostname: normalizeHostname(domain.hostname) }));
    if (new Set(domains.map((domain) => domain.hostname)).size !== domains.length) throw new Error('Service domains must be unique');
    return domains;
  }

  private async save(application: string, value: ServiceDomain[]) {
    const domains = this.validate(value);
    const directory = path.join(this.appsDir, application);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.filePath(application);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(domains, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  private filePath(application: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(application)) throw new Error('Invalid application name');
    return path.join(this.appsDir, application, 'domains.json');
  }

  private addressFromBaseDomain(baseDomain?: string) {
    const match = baseDomain?.match(/^(\d{1,3}(?:\.\d{1,3}){3})\.nip\.io$/);
    return match?.[1];
  }

  private checkHttps(hostname: string) {
    return new Promise<boolean>((resolve) => {
      const socket = tls.connect({ host: hostname, port: 443, servername: hostname, rejectUnauthorized: true });
      const finish = (ready: boolean) => {
        socket.destroy();
        resolve(ready);
      };
      socket.setTimeout(2500, () => finish(false));
      socket.once('secureConnect', () => finish(socket.authorized));
      socket.once('error', () => finish(false));
    });
  }
}
