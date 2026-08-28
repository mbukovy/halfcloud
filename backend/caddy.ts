interface RoutedApplication {
  hostname?: string;
  domains?: Array<{
    hostname: string;
    access: { type: 'public' } | { type: 'basic_auth'; username: string; passwordHash: string };
  }>;
  ports: Array<{ host: number; protocol: string }>;
  state: string;
}

export class CaddyService {
  private readonly endpoint = process.env.CADDY_ADMIN_URL ?? 'http://127.0.0.1:2019';
  private readonly halfcloudHostname = process.env.HALFCLOUD_HOSTNAME;
  private readonly halfcloudPort = Number(process.env.PORT ?? 9000);

  async sync(applications: RoutedApplication[]) {
    if (!this.halfcloudHostname) throw new Error('HALFCLOUD_HOSTNAME is required for Caddy configuration');
    const sites = applications
      .filter((application) => (application.domains?.length || application.hostname) && application.state === 'running')
      .map((application) => {
        const port = application.ports.find((candidate) => candidate.protocol === 'tcp')?.host;
        if (!port) return '';
        const domains = application.domains ?? [{ hostname: application.hostname!, access: { type: 'public' as const } }];
        return domains.map((domain) => {
          const authentication = domain.access.type === 'basic_auth'
            ? `  basic_auth {\n    ${domain.access.username} ${domain.access.passwordHash}\n  }\n`
            : '';
          return `${domain.hostname} {\n${authentication}  reverse_proxy 127.0.0.1:${port}\n}`;
        }).join('\n\n');
      })
      .filter(Boolean);
    const caddyfile = `{
  admin 127.0.0.1:2019
}

${this.halfcloudHostname} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${this.halfcloudPort}
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "same-origin"
    -Server
  }
}

${sites.join('\n\n')}
`;
    const response = await fetch(`${this.endpoint}/load`, {
      method: 'POST',
      headers: {
        'content-type': 'text/caddyfile',
        origin: new URL(this.endpoint).origin,
      },
      body: caddyfile,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Caddy rejected the generated proxy configuration');
  }
}
