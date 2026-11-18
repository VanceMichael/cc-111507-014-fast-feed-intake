import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { compileTemplates } from './fast/templates.mjs';
import { decodeFeed } from './fast/decoder.mjs';

export async function collect({ input, descriptor, sourceBase, store }) {
  if (input.mode === 'raw') {
    const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
    const blob = await store.blob(source.bytes);
    const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
      source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
      records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
    return { receipt };
  }
  return collectStructured({ descriptor, sourceBase, store });
}

async function collectStructured({ descriptor, sourceBase, store }) {
  const blobs = [];
  const evidence = {};
  const keepBlob = async (name, role, bytes) => {
    const blob = await store.blob(bytes);
    blobs.push({ ...blob, name, role });
    return blob;
  };
  const fetchResource = (name) => {
    if (!descriptor.resources.includes(name)) throw new Error(`资源未在来源清单中：${name}`);
    return receiveBytes(`${sourceBase}/files/${encodeURIComponent(name)}`);
  };
  const reject = async (message, extra = {}) => {
    const receipt = await store.save({
      state: 'rejected', mode: 'structured', product: descriptor.product,
      source: descriptor.entry, sourceVersion: evidence.source?.etag ?? null,
      metadata: extra.metadata ?? null, blobs, records: [],
      issues: [{ kind: 'rejected', message }],
      coverage: { structured: true, complete: false, reason: message, ...(extra.coverage ?? {}) },
      evidence,
    });
    return { receipt };
  };
  let source;
  try {
    source = await fetchResource(descriptor.entry);
  } catch (error) {
    return reject(`来源入口不可取得：${error.message}`);
  }
  const entryBlob = await keepBlob(descriptor.entry, 'entry', source.bytes);
  evidence.source = { name: descriptor.entry, digest: entryBlob.digest, bytes: source.bytes.length, etag: source.etag };
  const metadata = inspect(source.bytes);
  const manifestName = descriptor.resources.find((name) => name === 'feed-manifest.json')
    ?? descriptor.resources.find((name) => /manifest.*\.json$/i.test(name));
  if (!manifestName) return reject('来源清单缺失', { metadata });
  let manifestBytes;
  try {
    manifestBytes = await fetchResource(manifestName);
  } catch (error) {
    return reject(`来源清单不可取得：${error.message}`, { metadata });
  }
  const manifestBlob = await keepBlob(manifestName, 'manifest', manifestBytes.bytes);
  evidence.manifest = { name: manifestName, digest: manifestBlob.digest, etag: manifestBytes.etag };
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.bytes.toString('utf8'));
  } catch {
    manifest = null;
  }
  if (!manifest || !Array.isArray(manifest.frames)) return reject('来源清单无效', { metadata });
  const session = typeof manifest.session === 'string' && manifest.session ? manifest.session : 'default';
  const templateFile = manifest.templateFile;
  if (typeof templateFile !== 'string' || !descriptor.resources.includes(templateFile)) {
    return reject('模板文件未在来源清单中', { metadata, coverage: { session } });
  }
  let templateBytes;
  try {
    templateBytes = await fetchResource(templateFile);
  } catch (error) {
    return reject(`模板不可取得：${error.message}`, { metadata, coverage: { session } });
  }
  const templateBlob = await keepBlob(templateFile, 'templates', templateBytes.bytes);
  evidence.templates = { name: templateFile, digest: templateBlob.digest, etag: templateBytes.etag };
  let compiled;
  try {
    compiled = compileTemplates(templateBytes.bytes.toString('utf8'));
  } catch (error) {
    return reject(`模板解析失败：${error.message}`, { metadata, coverage: { session } });
  }
  const outcome = decodeFeed({ bytes: source.bytes, manifest, compiled, session, blobDigest: entryBlob.digest });
  const receipt = await store.save({
    state: outcome.state, mode: 'structured', product: descriptor.product,
    source: descriptor.entry, sourceVersion: source.etag, session,
    metadata, blobs,
    records: outcome.records, issues: outcome.issues,
    coverage: outcome.coverage, evidence,
  });
  return { receipt };
}
