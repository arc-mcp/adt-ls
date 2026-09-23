import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROXY_CERT_ALIAS,
  buildTruststore,
  generateLocalhostCert,
  prepareAdtLsTls,
  resolveJreTools,
} from '../src/connection/cert.js';
import { resolveAdtLsPath } from '../src/discovery.js';

function hasTool(tool: string): boolean {
  try {
    execFileSync(tool, ['-help'], { stdio: 'ignore' });
    return true;
  } catch (e: unknown) {
    // openssl/keytool exit non-zero for -help but ARE present; ENOENT = missing.
    return (e as { code?: string }).code !== 'ENOENT';
  }
}

describe('resolveJreTools (platform layouts)', () => {
  let root: string;
  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'adtls-cert-test-'));
  });
  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function makeLayout(binRel: string, keytoolRel: string): Promise<string> {
    const base = await fsp.mkdtemp(path.join(root, 'layout-'));
    const bin = path.join(base, binRel);
    const keytool = path.join(base, keytoolRel);
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    await fsp.mkdir(path.dirname(keytool), { recursive: true });
    await fsp.writeFile(bin, '#!/bin/sh\n');
    await fsp.writeFile(keytool, '#!/bin/sh\n');
    const cacerts = path.join(path.dirname(keytool), '..', 'lib', 'security', 'cacerts');
    await fsp.mkdir(path.dirname(cacerts), { recursive: true });
    await fsp.writeFile(cacerts, 'x');
    return bin;
  }

  it('finds keytool in the linux layout (binDir/plugins/com.sap.adt.jvm.*/jre/bin)', async () => {
    const bin = await makeLayout(
      'adt-ls',
      'plugins/com.sap.adt.jvm.sapmachineminimal.linux.x86_64_21.11.0/jre/bin/keytool',
    );
    const tools = resolveJreTools(bin);
    expect(fs.existsSync(tools.keytool)).toBe(true);
    expect(tools.keytool).toContain('com.sap.adt.jvm.');
    expect(tools.cacerts).toContain(path.join('lib', 'security', 'cacerts'));
  });

  it('finds keytool in the macOS layout (binDir/../Eclipse/plugins/com.sap.adt.jvm.*/jre/bin)', async () => {
    const bin = await makeLayout(
      'Contents/MacOS/adt-ls',
      'Contents/Eclipse/plugins/com.sap.adt.jvm.sapmachineminimal.macosx.aarch64_21.11.0/jre/bin/keytool',
    );
    const tools = resolveJreTools(bin);
    expect(fs.existsSync(tools.keytool)).toBe(true);
  });

  it('throws a helpful error when no JRE is found', async () => {
    const base = await fsp.mkdtemp(path.join(root, 'empty-'));
    const bin = path.join(base, 'adt-ls');
    await fsp.writeFile(bin, '');
    expect(() => resolveJreTools(bin)).toThrow(/Could not locate the adt-ls JRE keytool/);
  });
});

// Gated (Tier 2): needs openssl (cert gen) + a real adt-ls (for keytool + cacerts).
let binPath: string | null = null;
try {
  binPath = resolveAdtLsPath();
} catch {
  binPath = null;
}
const canBuild = binPath !== null && hasTool('openssl');

describe('cert/truststore build (needs openssl + adt-ls JRE)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'adtls-tls-'));
  });
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it.skipIf(!canBuild)('generateLocalhostCert produces a CN=localhost PEM keypair', async () => {
    const cert = await generateLocalhostCert(dir);
    expect(cert.certPem).toContain('BEGIN CERTIFICATE');
    expect(cert.keyPem).toContain('PRIVATE KEY');
    expect(fs.existsSync(cert.certPath)).toBe(true);
  });

  it.skipIf(!canBuild)('buildTruststore imports the proxy cert into a copy of cacerts', async () => {
    const { keytool, cacerts } = resolveJreTools(binPath as string);
    const cert = await generateLocalhostCert(dir);
    const out = path.join(dir, 'truststore.p12');
    await buildTruststore({ keytool, cacerts, certPath: cert.certPath, outPath: out });
    // Pin keytool's locale: the entry-count line below is localized (e.g. German on a de_DE host).
    const listing = execFileSync(
      keytool,
      ['-J-Duser.language=en', '-J-Duser.country=US', '-list', '-keystore', out, '-storepass', 'changeit'],
      { encoding: 'utf8' },
    );
    expect(listing).toContain(PROXY_CERT_ALIAS);
    expect(listing).toMatch(/Your keystore contains \d+ entries/);
  });

  it.skipIf(!canBuild)('prepareAdtLsTls returns proxy PEMs + a JAVA_TOOL_OPTIONS truststore', async () => {
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'adtls-prep-'));
    try {
      const tls = await prepareAdtLsTls({ adtLsBin: binPath as string, workDir: work });
      expect(tls.proxyKeyPem).toContain('PRIVATE KEY');
      expect(tls.proxyCertPem).toContain('BEGIN CERTIFICATE');
      expect(tls.javaToolOptions).toContain('-Djavax.net.ssl.trustStore=');
      expect(fs.existsSync(tls.trustStorePath)).toBe(true);
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  });
});
