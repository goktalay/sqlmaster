// Bağlantı açma: gerekiyorsa önce SSH tüneli kurar, sonra sağlayıcıya yerel uç noktayı verir.
import net from 'node:net';
import crypto from 'node:crypto';
import { Client as SshClient } from 'ssh2';
import type { ConnectionConfig, IDataSourceConnection } from '../provider';
import { getProvider } from '../registry';

export interface Tunnel {
  host: string;
  port: number;
  fingerprint: string;
  close(): void;
}

export class HostKeyMismatchError extends Error {
  constructor(readonly expected: string, readonly received: string) {
    super(`SSH sunucu anahtarı değişti (kayıtlı ${expected}, gelen ${received}). Güvenlik için bağlantı reddedildi.`);
  }
}

/** ssh2 ile yerel bir porttan uzak host:port'a tünel açar. Anahtarla giriş tercih edilir. */
export function openTunnel(cfg: ConnectionConfig): Promise<Tunnel> {
  const ssh = cfg.ssh!;
  const targetHost = cfg.host || 'localhost';
  const targetPort = cfg.port || 0;
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let fingerprint = '';
    let mismatch: HostKeyMismatchError | null = null;
    client.on('error', (e) => reject(mismatch ?? e));
    client.on('ready', () => {
      const server = net.createServer((sock) => {
        client.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, targetHost, targetPort, (err, stream) => {
          if (err) return sock.destroy();
          sock.pipe(stream).pipe(sock);
          stream.on('close', () => sock.destroy());
          sock.on('close', () => stream.close());
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        resolve({ host: '127.0.0.1', port: addr.port, fingerprint, close: () => { server.close(); client.end(); } });
      });
    });
    client.connect({
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      privateKey: ssh.auth === 'key' ? ssh.privateKey : undefined,
      passphrase: ssh.auth === 'key' ? ssh.passphrase || undefined : undefined,
      password: ssh.auth === 'password' ? ssh.password : undefined,
      agent: ssh.auth === 'agent' ? (process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK) : undefined,
      readyTimeout: cfg.connectTimeoutMs ?? 20000,
      keepaliveInterval: 15000,
      hostVerifier: (key: Buffer) => {
        fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        if (ssh.hostKey && ssh.hostKey !== fingerprint) {
          mismatch = new HostKeyMismatchError(ssh.hostKey, fingerprint);
          return false;
        }
        return true;
      },
    });
  });
}

export interface OpenedConnection {
  conn: IDataSourceConnection;
  /** SSH tüneli kurulduysa sunucu anahtarı parmak izi (ilk bağlantıda kaydedilir) */
  sshFingerprint?: string;
}

export async function openConnection(cfg: ConnectionConfig): Promise<OpenedConnection> {
  const provider = getProvider(cfg.provider);
  if (!cfg.ssh?.enabled || provider.capabilities.kind === 'file') return { conn: await provider.connect(cfg) };
  const tunnel = await openTunnel({ ...cfg, port: cfg.port || provider.defaultPort });
  try {
    const conn = await provider.connect({ ...cfg, host: tunnel.host, port: tunnel.port });
    const close = conn.close.bind(conn);
    conn.close = async () => {
      try { await close(); } finally { tunnel.close(); }
    };
    return { conn, sshFingerprint: tunnel.fingerprint };
  } catch (e) {
    tunnel.close();
    throw e;
  }
}
