import { defineTool, toolSuccess, toolError, toolRejected } from '../../ai/tools/contract';
import { createHash } from 'node:crypto';
import { FileWriteApprover } from '../../features/file-approval';
import { FileTransactionManager } from '../../history';
import { IFileSystem } from '../../types';
import type { ToolDef, ToolExecutionContext } from '../../ai/tools';

const MEMORY_PATH = 'AIWRITER.md';
const START_MARKER = '<!-- aiwriter:writing-preferences:start -->';
const END_MARKER = '<!-- aiwriter:writing-preferences:end -->';
const MAX_PREFERENCE_CHARS = 500;
const MAX_PREFERENCES = 50;

export interface WritingPreferenceUpdate {
  action: 'remember' | 'forget' | 'replace';
  preference: string;
  previousPreference?: string;
}

export interface WritingPreferenceApplication {
  success: boolean;
  changed: boolean;
  content: string;
  message: string;
}

export function applyWritingPreferenceUpdate(
  originalContent: string,
  input: WritingPreferenceUpdate
): WritingPreferenceApplication {
  const preference = normalizePreference(input.preference);
  const previous = normalizePreference(input.previousPreference || '');
  if (!preference) {
    return { success: false, changed: false, content: originalContent, message: '写作偏好不能为空' };
  }
  if (preference.length > MAX_PREFERENCE_CHARS) {
    return {
      success: false,
      changed: false,
      content: originalContent,
      message: `单条写作偏好不能超过 ${MAX_PREFERENCE_CHARS} 个字符`,
    };
  }

  const section = readPreferenceSection(originalContent);
  const preferences = [...section.preferences];
  if (input.action === 'forget') {
    const index = preferences.indexOf(preference);
    if (index < 0) {
      return { success: true, changed: false, content: originalContent, message: '没有找到完全匹配的长期写作偏好' };
    }
    preferences.splice(index, 1);
  } else {
    if (input.action === 'replace' && previous) {
      const index = preferences.indexOf(previous);
      if (index >= 0) {
        preferences.splice(index, 1);
      }
    }
    if (!preferences.includes(preference)) {
      preferences.push(preference);
    }
  }

  if (preferences.length > MAX_PREFERENCES) {
    return {
      success: false,
      changed: false,
      content: originalContent,
      message: `长期写作偏好最多保存 ${MAX_PREFERENCES} 条，请先删除或合并旧偏好`,
    };
  }
  const content = writePreferenceSection(originalContent, section, preferences);
  return {
    success: true,
    changed: content !== originalContent,
    content,
    message: input.action === 'forget' ? '长期写作偏好已删除' : '长期写作偏好已保存',
  };
}

export function createWritingPreferenceTool(
  fileSystem: IFileSystem,
  fileWriteApprover: FileWriteApprover,
  transactionManager?: FileTransactionManager
): ToolDef {
  return defineTool({
    name: 'rememberWritingPreference',
    description: `仅当用户明确要求“记住、保存、以后默认采用”某项长期写作格式或风格偏好时使用。宿主会把偏好写入 ${MEMORY_PATH} 的受管区块，模型不需要猜测路径。不要保存剧情事实、人物信息、临时任务、敏感信息或推测。支持 remember、forget、replace。`,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['remember', 'forget', 'replace'],
          description: '保存、删除或替换长期写作偏好',
        },
        preference: {
          type: 'string',
          description: '独立、简洁、不含敏感信息的长期写作偏好；forget 时应与已有偏好语义一致且尽量原样引用',
        },
        previousPreference: {
          type: 'string',
          description: 'replace 时可选：要替换的旧偏好',
        },
      },
      required: ['action', 'preference'],
    },
    maxCallsPerRequest: 3,
    func: async (params: any, signal?: AbortSignal, context?: ToolExecutionContext) => {
      throwIfAborted(signal);
      const action = String(params?.action || '').trim() as WritingPreferenceUpdate['action'];
      if (!['remember', 'forget', 'replace'].includes(action)) {
        return toolError('invalid_arguments', '参数错误: action 必须是 remember、forget 或 replace');
      }
      const originalResult = await fileSystem.readFile(MEMORY_PATH);
      if (!originalResult.success) {
        return toolError('preference_update_failed', `保存失败: ${MEMORY_PATH} 尚未初始化或无法读取`);
      }
      const originalContent = originalResult.content || '';
      const application = applyWritingPreferenceUpdate(originalContent, {
        action,
        preference: String(params?.preference || ''),
        previousPreference: String(params?.previousPreference || ''),
      });
      if (!application.success) {
        return toolError('preference_update_failed', `保存失败: ${application.message}`);
      }
      if (!application.changed) {
        return toolSuccess(application.message, undefined, 'no_change');
      }

      const pathValidation = await fileSystem.validatePath(MEMORY_PATH);
      if (!pathValidation.success || !pathValidation.content) {
        return toolError('preference_update_failed', `保存失败: ${pathValidation.message}`);
      }
      const filepath = pathValidation.content;
      const approved = await fileWriteApprover.confirmFileWrite(
        filepath,
        'edit',
        originalContent,
        application.content,
        signal,
        { requestId: context?.requestId }
      );
      throwIfAborted(signal);
      if (!approved) {
        return toolRejected('user_rejected', '用户已取消保存长期写作偏好');
      }

      const latest = await fileSystem.readFile(MEMORY_PATH);
      if (!latest.success || (latest.content || '') !== originalContent) {
        return toolError('file_conflict', `保存冲突: ${MEMORY_PATH} 在确认期间发生了变化，请重试`);
      }
      const result = await transactionManager?.executeWrite(
        context?.requestId,
        filepath,
        application.content,
        () => fileSystem.editFile(filepath, application.content)
      ) || await fileSystem.editFile(filepath, application.content);
      if (!result.success) {
        return toolError('preference_update_failed', `保存失败: ${result.message}`);
      }

      context?.onFileMutation?.({
        tool: 'rememberWritingPreference',
        filepath,
        mode: 'managed-writing-preferences',
        changed: true,
        beforeExists: true,
        afterExists: true,
        beforeChars: originalContent.length,
        afterChars: application.content.length,
        beforeSha256: createHash('sha256').update(originalContent).digest('hex'),
        afterSha256: createHash('sha256').update(application.content).digest('hex'),
      });
      return toolSuccess(`${application.message}，已写入 ${MEMORY_PATH}`);
    },
  });
}

function normalizePreference(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^[-*]\s+/, '');
}

function readPreferenceSection(content: string): {
  start: number;
  end: number;
  preferences: string[];
} {
  const start = content.indexOf(START_MARKER);
  const endMarkerIndex = start >= 0 ? content.indexOf(END_MARKER, start + START_MARKER.length) : -1;
  if (start < 0 || endMarkerIndex < 0) {
    return { start: -1, end: -1, preferences: [] };
  }
  const end = endMarkerIndex + END_MARKER.length;
  const body = content.slice(start + START_MARKER.length, endMarkerIndex);
  const preferences = body.split(/\r?\n/)
    .map(line => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1])
    .filter((value): value is string => !!value)
    .map(normalizePreference);
  return { start, end, preferences: [...new Set(preferences)] };
}

function writePreferenceSection(
  originalContent: string,
  section: { start: number; end: number },
  preferences: string[]
): string {
  const block = preferences.length > 0
    ? [
        START_MARKER,
        '## 用户确认的长期写作偏好',
        '',
        ...preferences.map(preference => `- ${preference}`),
        END_MARKER,
      ].join('\n')
    : '';
  if (section.start >= 0 && section.end >= 0) {
    const before = originalContent.slice(0, section.start).trimEnd();
    const after = originalContent.slice(section.end).trimStart();
    return [before, block, after].filter(Boolean).join('\n\n').trimEnd() + '\n';
  }
  return [originalContent.trimEnd(), block].filter(Boolean).join('\n\n').trimEnd() + '\n';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    throw error;
  }
}
