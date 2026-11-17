import { receiveBytes } from './http-client.mjs';
import { inspect } from './source-metadata.mjs';
import { decodeSession } from './fast/session.mjs';
import { FastError } from './fast/primitives.mjs';

async function fetchResource(store, sourceBase, name, role) {
  const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(name)}`);
  const blob = await store.blob(source.bytes);
  return { bytes: source.bytes, etag: source.etag, blob: { ...blob, role, source: name } };
}

export async function collect({ input, descriptor, sourceBase, store }) {
  if (!['raw', 'structured'].includes(input.mode)) {
    return { httpStatus: 400, error: '接收方式无效' };
  }
  if (input.mode === 'raw') {
    const source = await receiveBytes(`${sourceBase}/files/${encodeURIComponent(descriptor.entry)}`);
    const blob = await store.blob(source.bytes);
    const receipt = await store.save({ state: 'received', mode: 'raw', product: descriptor.product,
      source: descriptor.entry, sourceVersion: source.etag, metadata: inspect(source.bytes), blobs: [blob],
      records: [], issues: [], coverage: { structured: false, downloadedBytes: source.bytes.length } });
    return { receipt };
  }

  // 结构化收件：原文、模板与 manifest 均作为证据留存，任何环节失败都不丢弃已取得的原文。
  const evidence = [];
  const blobs = [];
  const partial = { mode: 'structured', product: descriptor.product, source: descriptor.entry };
  try {
    const feed = await fetchResource(store, sourceBase, descriptor.entry, 'feed');
    evidence.push({ role: 'feed', source: descriptor.entry, etag: feed.etag, digest: feed.blob.digest });
    blobs.push(feed.blob);

    let manifest;
    try {
      const manifestName = 'feed-manifest.json';
      if (!descriptor.resources.includes(manifestName)) throw new FastError('RESOURCE_MISSING', '来源清单未提供 feed-manifest.json');
      const manifestFile = await fetchResource(store, sourceBase, manifestName, 'manifest');
      evidence.push({ role: 'manifest', source: manifestName, etag: manifestFile.etag, digest: manifestFile.blob.digest });
      blobs.push(manifestFile.blob);
      manifest = JSON.parse(manifestFile.bytes.toString());
    } catch (error) {
      const message = error instanceof SyntaxError ? '来源 manifest 不是合法 JSON' : error.message;
      const receipt = await store.save({ ...partial, state: 'rejected', sourceVersion: feed.etag,
        metadata: inspect(feed.bytes), blobs, records: [],
        issues: [{ severity: 'error', code: 'MANIFEST_UNAVAILABLE', message }],
        coverage: { structured: true, complete: false, reason: message }, evidence });
      return { receipt, httpStatus: 201 };
    }

    let templateXml;
    try {
      const templateName = manifest.templateFile;
      if (!templateName || !descriptor.resources.includes(templateName)) {
        throw new FastError('RESOURCE_MISSING', '来源清单未提供模板文件');
      }
      const templateFile = await fetchResource(store, sourceBase, templateName, 'templates');
      evidence.push({ role: 'templates', source: templateName, etag: templateFile.etag, digest: templateFile.blob.digest });
      blobs.push(templateFile.blob);
      templateXml = templateFile.bytes.toString('utf8');
    } catch (error) {
      const receipt = await store.save({ ...partial, state: 'rejected', sourceVersion: feed.etag,
        metadata: inspect(feed.bytes), blobs, records: [],
        issues: [{ severity: 'error', code: 'TEMPLATE_UNAVAILABLE', message: error.message }],
        coverage: { structured: true, complete: false, reason: error.message, session: manifest.session }, evidence });
      return { receipt, httpStatus: 201 };
    }

    const result = decodeSession({ feedBytes: feed.bytes, manifest, templateXml });
    const receipt = await store.save({ ...partial, state: result.state, sourceVersion: feed.etag,
      metadata: inspect(feed.bytes), blobs, records: result.records, issues: result.issues,
      coverage: result.coverage, evidence });
    return { receipt };
  } catch (error) {
    if (error instanceof FastError) {
      const receipt = await store.save({ ...partial, state: 'rejected',
        metadata: { format: 'FAST' }, blobs, records: [],
        issues: [{ severity: 'error', code: error.code, message: error.message, ...(error.issues ? { details: error.issues } : {}) }],
        coverage: { structured: true, complete: false, reason: error.message }, evidence });
      return { receipt, httpStatus: 201 };
    }
    throw error;
  }
}
