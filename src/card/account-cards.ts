import type { AccountProfile, TenantBrand } from '../config/schema';

function maskAppId(id: string): string {
  if (id.length < 12) return id;
  return `${id.slice(0, 13)}****${id.slice(-2)}`;
}

export interface CurrentInfo {
  appId: string;
  botName?: string;
  tenant: TenantBrand;
  /** Saved profiles available for switching. */
  profiles?: AccountProfile[];
}

export function accountCurrentCard(info: CurrentInfo): object {
  return {
    schema: '2.0',
    config: { summary: { content: '当前应用' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '📋 **当前应用**',
            '',
            `**App ID**: \`${maskAppId(info.appId)}\``,
            `**Bot 名**: ${info.botName ?? '(未知)'}`,
            `**Tenant**: ${info.tenant}`,
            ...(info.profiles && info.profiles.length > 0
              ? [`**已存档案**: ${info.profiles.length} 个（可切换）`]
              : []),
          ].join('\n'),
        },
        { tag: 'hr' },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: [
            ...(info.profiles && info.profiles.length > 0
              ? [
                  {
                    tag: 'column',
                    width: 'auto',
                    elements: [
                      {
                        tag: 'button',
                        name: 'account_list',
                        text: { tag: 'plain_text', content: '账号列表 / 切换' },
                        type: 'primary',
                        behaviors: [{ type: 'callback', value: { cmd: 'account.list' } }],
                      },
                    ],
                  },
                ]
              : []),
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  name: 'account_add',
                  text: { tag: 'plain_text', content: '添加账号' },
                  behaviors: [{ type: 'callback', value: { cmd: 'account.add' } }],
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  name: 'account_change',
                  text: { tag: 'plain_text', content: '更换凭据' },
                  behaviors: [{ type: 'callback', value: { cmd: 'account.change' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** Entry card for /account add: QR-create or bind-an-existing-app. */
export function accountAddCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '添加账号' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '➕ **添加账号**\n\n' +
            '**扫码创建新应用**（推荐）\n' +
            '_用目标账号的飞书 App 扫码 / 打开链接登录验证,应用自动创建并录入。_\n\n' +
            '**绑定已有应用**\n' +
            '_应用已在开放平台建好（权限/事件/发布已配置）,填入 App ID 和 Secret 绑定。_',
        },
        { tag: 'hr' },
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
                  name: 'account_add_qr',
                  text: { tag: 'plain_text', content: '扫码创建新应用' },
                  type: 'primary',
                  behaviors: [{ type: 'callback', value: { cmd: 'account.add.qr' } }],
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  name: 'account_bind_existing',
                  text: { tag: 'plain_text', content: '绑定已有应用' },
                  behaviors: [{ type: 'callback', value: { cmd: 'account.change' } }],
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              elements: [
                {
                  tag: 'button',
                  name: 'account_add_cancel',
                  text: { tag: 'plain_text', content: '取消' },
                  behaviors: [{ type: 'callback', value: { cmd: 'account.cancel' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** QR/link card delivered while the registration is pending. */
export function accountQrCard(url: string, expireMinutes: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: '等待扫码...' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '⏳ **等待扫码验证...**',
            '',
            `1. 用**目标账号**的飞书 App 扫描,或直接打开下面的链接`,
            `2. 登录并确认创建,应用会自动录入到账号档案`,
            '',
            `**链接**: ${url}`,
            `**有效期**: 约 ${expireMinutes} 分钟`,
            '',
            '_完成后我会自动收到通知并保存档案。_',
          ].join('\n'),
        },
      ],
    },
  };
}

/** Enrollment success: saved as a profile, switchable via /account. */
export function accountEnrollSuccessCard(name: string, appId: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '账号已录入' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `✅ **账号已录入**: ${name}`,
            '',
            `**App ID**: \`${maskAppId(appId)}\``,
            '',
            '发送 `/account` 即可查看档案并切换。',
          ].join('\n'),
        },
      ],
    },
  };
}

export interface AccountListInfo {
  currentAppId: string;
  currentBotName?: string;
  profiles: AccountProfile[];
  /** Set when a form validation error should be shown above the list. */
  errorMessage?: string;
}

/** Profiles list + the switch dropdown (select inside a form). */
export function accountListCard(info: AccountListInfo): object {
  const listText = info.profiles
    .map((p) => `- **${p.name}** \`${maskAppId(p.appId)}\`（${p.tenant}）`)
    .join('\n');
  const options = info.profiles.map((p) => ({
    text: { tag: 'plain_text', content: p.name },
    value: p.appId,
  }));
  const errorBlock = info.errorMessage
    ? [{ tag: 'markdown', content: `❌ **${info.errorMessage}**` }]
    : [];
  return {
    schema: '2.0',
    config: { summary: { content: '账号档案' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '👤 **账号档案**',
            '',
            `**当前**: ${info.currentBotName ?? '(未知)'} \`${maskAppId(info.currentAppId)}\``,
            ...(info.profiles.length > 0
              ? ['**已存档案**:', '', listText]
              : ['_暂无其他已存档案。点下方「添加账号」录入。_']),
          ].join('\n'),
        },
        { tag: 'hr' },
        ...errorBlock,
        ...(options.length > 0
          ? [
              {
                tag: 'form',
                name: 'account_switch_form',
                elements: [
                  {
                    tag: 'select_static',
                    name: 'account_switch_target',
                    placeholder: { tag: 'plain_text', content: '选择要切换到的账号' },
                    options,
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
                            name: 'account_switch_submit',
                            text: { tag: 'plain_text', content: '切换' },
                            type: 'primary',
                            form_action_type: 'submit',
                            behaviors: [{ type: 'callback', value: { cmd: 'account.switch' } }],
                          },
                        ],
                      },
                      {
                        tag: 'column',
                        width: 'auto',
                        elements: [
                          {
                            tag: 'button',
                            name: 'account_switch_cancel',
                            text: { tag: 'plain_text', content: '取消' },
                            behaviors: [{ type: 'callback', value: { cmd: 'account.cancel' } }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ]
          : []),
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
                  name: 'account_list_add',
                  text: { tag: 'plain_text', content: '➕ 添加账号' },
                  behaviors: [{ type: 'callback', value: { cmd: 'account.add' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

export function accountSwitchProgressCard(fromName: string, toName: string, note?: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '正在切换账号' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `⏳ **正在切换**\n\n${fromName} → **${toName}**\n\n` +
            '_正在建立连接，通常需要 3–8 秒。请等待最终结果。_' +
            (note ? `\n\nℹ️ ${note}` : ''),
        },
      ],
    },
  };
}

export function accountSwitchConnectedCard(
  fromName: string,
  toName: string,
  connectedAt: Date,
  note?: string,
): object {
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(connectedAt);
  return {
    schema: '2.0',
    config: { summary: { content: '账号切换完成' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `✅ **切换完成**\n\n${fromName} → **${toName}**\n\n` +
            `连接已恢复，新 bot 已接管本机 Agent。\n\n**完成时间**：${time}\n\n` +
            `请前往 **${toName}** 的会话继续使用。` +
            (note ? `\n\nℹ️ ${note}` : ''),
        },
      ],
    },
  };
}

export function accountSwitchFailedCard(
  fromName: string,
  toName: string,
  reason: string,
  restored = true,
  rollbackError?: string,
): object {
  return {
    schema: '2.0',
    config: { summary: { content: '账号切换失败' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `❌ **切换失败**\n\n${fromName} → **${toName}**\n\n` +
            `未能连接新 bot：${reason}\n\n` +
            (restored
              ? `当前仍由 **${fromName}** 提供服务，原配置已恢复。\n\n发送 \`/account\` 可以重试。`
              : `旧 bot 仍在线，但配置回滚失败：${rollbackError ?? 'unknown'}\n\n请不要重启服务，并检查本机配置。`),
        },
      ],
    },
  };
}

export function accountTakeoverCard(name: string, fromName: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: `${name} 已上线` } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `✅ **${name} 已上线**\n\n` +
            `已从 ${fromName} 接管本机 Agent，现在可以继续发送消息。`,
        },
      ],
    },
  };
}

export interface FormCardOpts {
  initialTenant?: TenantBrand;
  prefillAppId?: string;
  errorMessage?: string;
}

export function accountFormCard(opts: FormCardOpts = {}): object {
  const { initialTenant = 'feishu', prefillAppId, errorMessage } = opts;
  const bodyElements: object[] = [];
  if (errorMessage) {
    bodyElements.push({
      tag: 'markdown',
      content: `❌ **校验失败**：${errorMessage}`,
    });
  }
  bodyElements.push({
    tag: 'form',
    name: 'account_form',
    elements: [
      {
        tag: 'input',
        name: 'app_id',
        label: { tag: 'plain_text', content: 'App ID' },
        placeholder: { tag: 'plain_text', content: 'cli_xxxxxxxxxxxx' },
        ...(prefillAppId ? { default_value: prefillAppId } : {}),
        required: true,
      },
      {
        tag: 'input',
        name: 'app_secret',
        label: { tag: 'plain_text', content: 'App Secret' },
        placeholder: { tag: 'plain_text', content: '32 位字符串' },
        // Never prefill secret — even on validation retry. Pre-filled secrets
        // can leak into Lark's server-side card cache.
        required: true,
      },
      { tag: 'markdown', content: '**Tenant**' },
      {
        tag: 'select_static',
        name: 'tenant',
        initial_option: initialTenant,
        options: [
          { text: { tag: 'plain_text', content: 'Feishu (国内)' }, value: 'feishu' },
          { text: { tag: 'plain_text', content: 'Lark (海外)' }, value: 'lark' },
        ],
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
                behaviors: [{ type: 'callback', value: { cmd: 'account.submit' } }],
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
                behaviors: [{ type: 'callback', value: { cmd: 'account.cancel' } }],
              },
            ],
          },
        ],
      },
    ],
  });

  return {
    schema: '2.0',
    config: { summary: { content: '更换凭据' } },
    body: { elements: bodyElements },
  };
}

export function accountValidatingCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '正在校验...' } },
    body: { elements: [{ tag: 'markdown', content: '⏳ **正在校验凭据...**' }] },
  };
}

export function accountFailureCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '校验失败' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `❌ **校验失败**\n\n\`${reason}\`\n\n请检查 App ID 和 Secret 是否正确，重发 \`/account change\` 重试。`,
        },
      ],
    },
  };
}

export function accountCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: { elements: [{ tag: 'markdown', content: '已取消，未做任何修改。' }] },
  };
}
