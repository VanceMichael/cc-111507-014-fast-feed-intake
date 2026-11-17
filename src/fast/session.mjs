// 会话级 FAST 收件：按来源 manifest 切帧，维护字典作用域、显式重置与源流缺口状态。
// 关键纪律：缺口使依赖字典的解释依据失效；在合法重置恢复前停止发布依赖状态的消息，
// 只保留原文并报告 blocked，绝不沿用陈旧值拼凑连续行情。

import { createHash } from 'node:crypto';
import { FastError } from './primitives.mjs';
import { parseTemplates } from './templates.mjs';
import { FastDictionary, decodeFrame, stableRecordId } from './decoder.mjs';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function validateManifest(manifest, blobLength) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object') throw new FastError('MANIFEST_INVALID', '来源 manifest 不是合法 JSON 对象');
  if (typeof manifest.session !== 'string' || !manifest.session) throw new FastError('MANIFEST_INVALID', 'manifest 缺少 session');
  if (!Array.isArray(manifest.frames) || !manifest.frames.length) throw new FastError('MANIFEST_INVALID', 'manifest 缺少 frames');
  if (!Array.isArray(manifest.resets)) manifest.resets = [];
  let cursor = 0;
  manifest.frames.forEach((frame, index) => {
    const where = `frames[${index}]`;
    if (!Number.isInteger(frame.sequence) || frame.sequence < 0) issues.push({ severity: 'error', code: 'MANIFEST_FRAME', message: `${where} sequence 非法` });
    if (!Number.isInteger(frame.offset) || frame.offset < 0) issues.push({ severity: 'error', code: 'MANIFEST_FRAME', message: `${where} offset 非法` });
    if (!Number.isInteger(frame.length) || frame.length <= 0) issues.push({ severity: 'error', code: 'MANIFEST_FRAME', message: `${where} length 非法` });
    if (frame.offset !== cursor) issues.push({ severity: 'error', code: 'MANIFEST_GAP', offset: frame.offset, message: `${where} 偏移不连续（期望 ${cursor}，实际 ${frame.offset}）` });
    cursor = frame.offset + frame.length;
  });
  if (cursor !== blobLength) {
    issues.push({ severity: 'error', code: 'MANIFEST_COVERAGE', message: `manifest 覆盖 ${cursor} 字节，来源共 ${blobLength} 字节，存在未归属字节` });
  }
  const resetUnknown = manifest.resets.filter(seq => !manifest.frames.some(frame => frame.sequence === seq));
  for (const seq of resetUnknown) issues.push({ severity: 'error', code: 'MANIFEST_RESET', message: `resets 中的 ${seq} 不对应任何帧` });
  const fatal = issues.filter(issue => issue.severity === 'error');
  if (fatal.length) {
    const error = new FastError('MANIFEST_INVALID', 'manifest 与来源字节不一致，无法建立帧边界');
    error.issues = issues;
    throw error;
  }
  return issues;
}

export function decodeSession({ feedBytes, manifest, templateXml }) {
  const coverageIssues = validateManifest(manifest, feedBytes.length);
  const issues = [...coverageIssues];
  const records = [];
  const { templates, unsupported } = parseTemplates(templateXml);
  for (const item of unsupported) {
    issues.push({ severity: 'warning', code: 'TEMPLATE_EXTENSION', ...item,
      message: `模板包含未承诺扩展：${item.reason}` });
  }
  const dictionaries = new FastDictionary();
  const resets = new Set(manifest.resets);
  let blocked = false;
  let blockReason = null;
  let priorTemplate = null;
  let expectedSequence = manifest.frames[0].sequence;
  let decodedCount = 0;
  let blockedCount = 0;

  for (const frame of manifest.frames) {
    const frameBytes = feedBytes.subarray(frame.offset, frame.offset + frame.length);
    const digest = sha256(frameBytes);
    const base = {
      recordId: stableRecordId(manifest.session, frame.sequence, frame.offset, digest),
      session: manifest.session,
      sequence: frame.sequence,
      templateId: null,
      templateName: null,
      offset: frame.offset,
      length: frame.length,
      rawDigest: digest,
      rawHex: frameBytes.toString('hex'),
    };
    // 先处理显式重置：来源声明的重置是恢复解释依据的唯一合法途径。
    if (resets.has(frame.sequence)) {
      dictionaries.reset();
      priorTemplate = null;
      blocked = false;
      blockReason = null;
      issues.push({ severity: 'info', code: 'DICTIONARY_RESET', sequence: frame.sequence, offset: frame.offset,
        message: `帧 ${frame.sequence} 按来源声明执行字典显式重置` });
    }
    // 检测源流序号缺口：缺口使依赖字典的后续解释全部失效。
    if (frame.sequence !== expectedSequence) {
      blocked = true;
      blockReason = { code: 'SEQUENCE_GAP', expected: expectedSequence, actual: frame.sequence };
      issues.push({ severity: 'error', code: 'SEQUENCE_GAP', sequence: frame.sequence, offset: frame.offset,
        message: `来源序号缺口：期望 ${expectedSequence}，实际 ${frame.sequence}；字典解释依据失效，等待合法重置` });
    }
    expectedSequence = frame.sequence + 1;

    if (blocked) {
      blockedCount += 1;
      records.push({ ...base, state: 'blocked', fields: null,
        issues: [{ code: blockReason?.code || 'BLOCKED', message: blockReason
          ? `源流缺口未恢复（期望 ${blockReason.expected}，收到 ${blockReason.actual}），停止发布依赖状态的消息`
          : '解释依据失效，等待合法重置' }] });
      continue;
    }

    try {
      const decoded = decodeFrame(frameBytes, frame, templates, dictionaries, priorTemplate, issues);
      priorTemplate = decoded.priorTemplate;
      decodedCount += 1;
      records.push({ ...base, state: 'decoded', templateId: decoded.templateId,
        templateName: decoded.templateName, fields: decoded.fields, issues: [] });
    } catch (error) {
      if (!(error instanceof FastError)) throw error;
      if (!blocked) {
        blocked = true;
        blockReason = { code: error.code, actual: frame.sequence };
      }
      blockedCount += 1;
      issues.push({ severity: 'error', code: error.code, sequence: frame.sequence, offset: frame.offset,
        message: `帧 ${frame.sequence} 无法按承诺范围解码：${error.message}` });
      records.push({ ...base, state: 'blocked', fields: null,
        issues: [{ code: error.code, message: error.message }] });
    }
  }

  const blockingErrors = issues.filter(issue => issue.severity === 'error').length;
  // 无阻断错误即 complete；帧可切分、原文均保留时即使全部 blocked 也是 partial；
  // rejected 只留给 manifest/模板层面完全无法解释的情形（由 receiver 兜底）。
  const state = blockingErrors === 0 ? 'complete' : 'partial';
  return {
    state,
    records,
    issues,
    coverage: {
      structured: true,
      session: manifest.session,
      sourceBytes: feedBytes.length,
      frameCount: manifest.frames.length,
      decodedCount,
      blockedCount,
      explicitResets: [...resets].sort((a, b) => a - b),
      dictionaryScopes: ['global', 'template', 'type'],
      complete: state === 'complete',
    },
  };
}
