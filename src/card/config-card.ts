import {
  AGENT_PERMISSION_MODES,
  CODEX_REASONING_EFFORTS,
  type AgentPermissionMode,
  type MessageReplyMode,
} from '../config/schema';

export interface ConfigFormOpts {
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  /** Opaque; undefined means inherit the agent CLI's own config. */
  agentReasoningEffort?: string;
  /** Undefined means read-only/default sandbox. */
  agentPermissionMode?: AgentPermissionMode;
  requireMentionInGroup: boolean;
  /** Comma-separated open_id allowlist; empty string = unrestricted. */
  allowedUsers: string;
  /** Comma-separated chat_id allowlist; empty string = unrestricted. */
  allowedChats: string;
  /** Comma-separated admin open_id list; empty string = no admin gating. */
  admins: string;
}

/** Form card for `/config`. */
export function configFormCard(opts: ConfigFormOpts): object {
  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚙️ **偏好设置**\n\n' +
            '调整 bot 的行为偏好。改完点提交,**立即生效**(无需重启)并写入 `~/.feishu-codex-bridge/config.json`。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'config_form',
          elements: [
            {
              tag: 'markdown',
              content:
                '**消息回复方式**\n' +
                '_纯文本:agent 跑完一次性发出,不流式,体感最轻_\n' +
                '_消息卡片:轻量流式 markdown 卡片,飞书原生打字机动画_',
            },
            {
              tag: 'select_static',
              name: 'message_reply',
              // 'card' (交互卡片) is hidden from the picker for now; existing
              // configs with `messageReply: 'card'` still work — showConfigForm
              // displays them as 'markdown' in the form, but submitting only
              // overwrites if the user actually picks something.
              initial_option: opts.messageReply === 'card' ? 'markdown' : opts.messageReply,
              options: [
                { text: { tag: 'plain_text', content: '纯文本' }, value: 'text' },
                { text: { tag: 'plain_text', content: '消息卡片(默认)' }, value: 'markdown' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**工具调用显示**\n' +
                '_显示:可以看到 bot 跑了什么命令、读了哪些文件等过程_\n' +
                '_隐藏:只看 agent 最终的文字答复,跳过所有工具块_',
            },
            {
              tag: 'select_static',
              name: 'show_tool_calls',
              initial_option: opts.showToolCalls ? 'show' : 'hide',
              options: [
                { text: { tag: 'plain_text', content: '显示(默认)' }, value: 'show' },
                { text: { tag: 'plain_text', content: '隐藏' }, value: 'hide' },
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**并发上限**\n' +
                '_全局同时运行的 agent 进程数(主要影响话题群多话题并行场景)_\n' +
                '_默认 10,范围 1-50。超出的请求会 FIFO 排队_',
            },
            {
              tag: 'input',
              name: 'max_concurrent_runs',
              default_value: String(opts.maxConcurrentRuns),
              placeholder: { tag: 'plain_text', content: '10' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**run 探活(分钟)**\n' +
                '_agent 长时间没输出时自动 kill,防止假死_\n' +
                '_0 = 关闭(默认),范围 1-120。可被 `/timeout` 在单个 scope 覆盖_',
            },
            {
              tag: 'input',
              name: 'run_idle_timeout_minutes',
              default_value: String(opts.runIdleTimeoutMinutes),
              placeholder: { tag: 'plain_text', content: '0' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**推理强度**\n' +
                '_默认:继承 agent CLI 自己的配置(Codex: CODEX_HOME/config.toml)_\n' +
                '_仅影响通过 bridge 发起的 run,不会修改 agent 的全局配置_',
            },
            {
              tag: 'select_static',
              name: 'agent_reasoning_effort',
              initial_option: opts.agentReasoningEffort ?? 'default',
              options: [
                { text: { tag: 'plain_text', content: '默认(继承 agent 配置)' }, value: 'default' },
                ...CODEX_REASONING_EFFORTS.map((value) => ({
                  text: { tag: 'plain_text', content: value },
                  value,
                })),
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**文件权限**\n' +
                '_只读:不会写文件。允许编辑:允许 agent 在当前 workspace 内写文件_\n' +
                '_全盘访问:允许 agent 访问整机文件系统,只建议短期个人排障使用_',
            },
            {
              tag: 'select_static',
              name: 'agent_permission_mode',
              initial_option: opts.agentPermissionMode ?? 'default',
              options: [
                { text: { tag: 'plain_text', content: '只读(默认)' }, value: 'default' },
                ...AGENT_PERMISSION_MODES.filter((value) => value !== 'default').map((value) => ({
                  text: {
                    tag: 'plain_text',
                    content:
                      value === 'acceptEdits'
                        ? '允许编辑(workspace-write)'
                        : value === 'bypassPermissions'
                          ? '全盘访问(danger-full-access)'
                          : value,
                  },
                  value,
                })),
              ],
            },
            {
              tag: 'markdown',
              content:
                '\n**群里需要 @ bot**\n' +
                '_是(默认):群和话题群里,不 @ bot 的消息不会触发回复,bot 不接群里聊天_\n' +
                '_否:任何消息都会发给 agent(0.1.21 及更早版本的行为)_\n' +
                '_私聊永远不需要 @;`@全员` 永远不响应_',
            },
            {
              tag: 'select_static',
              name: 'require_mention_in_group',
              initial_option: opts.requireMentionInGroup ? 'yes' : 'no',
              options: [
                { text: { tag: 'plain_text', content: '是(默认)' }, value: 'yes' },
                { text: { tag: 'plain_text', content: '否' }, value: 'no' },
              ],
            },
            { tag: 'hr' },
            {
              tag: 'markdown',
              content:
                '🔒 **访问控制**\n\n' +
                '_控制谁能跟 bot 交互、谁能跑敏感命令。留空 = 不限制（默认）_',
            },
            {
              tag: 'markdown',
              content:
                '\n**用户白名单**(`allowedUsers`)\n' +
                '_只允许列表内的 open_id 跟 bot 交互。多个用英文逗号分隔。留空 = 不限制_\n' +
                '_open_id 可从日志 `~/.feishu-codex-bridge/logs/*.log` 里 grep `senderId` 字段_',
            },
            {
              tag: 'input',
              name: 'allowed_users',
              default_value: opts.allowedUsers,
              placeholder: { tag: 'plain_text', content: 'ou_xxx, ou_yyy（留空=不限制）' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**群白名单**(`allowedChats`)\n' +
                '_只限制群（含话题群）——bot 只在名单内的群响应。多个用英文逗号分隔。留空 = 所有群都响应_\n' +
                '_⚠️ 私聊不受此约束,DM 的访问权由"用户白名单"决定_',
            },
            {
              tag: 'input',
              name: 'allowed_chats',
              default_value: opts.allowedChats,
              placeholder: { tag: 'plain_text', content: 'oc_xxx, oc_yyy（留空=所有群）' },
              input_type: 'text',
            },
            {
              tag: 'markdown',
              content:
                '\n**管理员**(`admins`)\n' +
                '_只允许这些 open_id 跑敏感命令: `/account` `/config` `/exit` `/reconnect` `/doctor` `/cd` `/ws`_\n' +
                '_留空 = 不做管理员限制(所有放行的用户都能跑)。⚠️ 改为非空时务必把自己包含在内,否则会自锁出 /config_',
            },
            {
              tag: 'input',
              name: 'admins',
              default_value: opts.admins,
              placeholder: { tag: 'plain_text', content: 'ou_xxx, ou_yyy（留空=不限制）' },
              input_type: 'text',
            },
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: { tag: 'plain_text', content: '提交' },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { cmd: 'config.submit' } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: { tag: 'plain_text', content: '取消' },
                      behaviors: [{ type: 'callback', value: { cmd: 'config.cancel' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  const replyLabel =
    opts.messageReply === 'card'
      ? '交互卡片'
      : opts.messageReply === 'markdown'
        ? '消息卡片'
        : '纯文本';
  const summarizeList = (raw: string): string => {
    const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return items.length === 0 ? '_(不限制)_' : `${items.length} 项`;
  };
  return {
    schema: '2.0',
    config: { summary: { content: '偏好已保存' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **偏好已保存**\n\n' +
            `**消息回复方式**:${replyLabel}\n` +
            `**工具调用显示**:\`${opts.showToolCalls ? 'show' : 'hide'}\`\n` +
            `**并发上限**:\`${opts.maxConcurrentRuns}\`\n` +
            `**run 探活**:\`${opts.runIdleTimeoutMinutes > 0 ? `${opts.runIdleTimeoutMinutes} 分钟` : '关闭'}\`\n` +
            `**推理强度**:\`${opts.agentReasoningEffort ?? '默认'}\`\n` +
            `**文件权限**:\`${opts.agentPermissionMode ?? '默认/只读'}\`\n` +
            `**群里需要 @ bot**:\`${opts.requireMentionInGroup ? '是' : '否'}\`\n\n` +
            '🔒 **访问控制**\n' +
            `**用户白名单**:${summarizeList(opts.allowedUsers)}\n` +
            `**群白名单**:${summarizeList(opts.allowedChats)}\n` +
            `**管理员**:${summarizeList(opts.admins)}\n\n` +
            '下条消息开始生效。',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [{ tag: 'markdown', content: '已取消,未做任何修改。' }],
    },
  };
}
