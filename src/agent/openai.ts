import type {
  AgentChatMessage,
  AgentAnswer,
  AgentCitation,
  AgentProvider,
  AgentRequest,
  AgentToolCall,
  ExecuteTool,
} from './types';

interface OpenAiResponse {
  id?: string;
  output?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    action?: { query?: string };
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        start_index?: number;
        end_index?: number;
        url?: string;
        title?: string;
        url_citation?: {
          start_index?: number;
          end_index?: number;
          url?: string;
          title?: string;
        };
      }>;
    }>;
  }>;
  output_text?: string;
}

const MAX_TOOL_ROUNDS = 16;

function toolProgress(call: AgentToolCall): string {
  try {
    const args = JSON.parse(call.arguments) as { name?: unknown; query?: unknown };
    const value = typeof args.name === 'string' ? args.name : args.query;
    return typeof value === 'string'
      ? `Scryfallを確認: ${value}`
      : `Scryfallツールを実行: ${call.name}`;
  } catch {
    return `Scryfallツールを実行: ${call.name}`;
  }
}

function deckText(request: AgentRequest): string {
  const commanders = request.deck.entries.filter((entry) => entry.isCommander);
  const mainCardCount = request.deck.entries.reduce(
    (total, entry) => total + entry.quantity,
    0,
  );
  const cards = request.deck.entries
    .map((entry) => `${entry.quantity}x ${entry.name}`)
    .join('\n');
  const metadata = request.deck.metadata;
  const candidates = (request.deck.candidates ?? [])
    .flatMap((section) => {
      const count = section.entries.reduce(
        (total, entry) => total + entry.quantity,
        0,
      );
      const isSideboard = /sideboard|side board|サイド/i.test(section.label);
      const heading = isSideboard
        ? `サイドボード: ${count}枚（メインデッキには含まない）`
        : `候補リスト (${section.label}): ${count}枚（メインデッキには含まない）`;
      return [
        heading,
        ...section.entries.map((entry) => `${entry.quantity}x ${entry.name}`),
      ];
    })
    .join('\n');
  return [
    `現在のデッキURL: ${request.deck.sourceUrl}`,
    metadata?.name ? `デッキ名: ${metadata.name}` : '',
    metadata?.format ? `フォーマット: ${metadata.format}` : 'フォーマット: 不明',
    metadata?.bracket ? `ブラケット: ${metadata.bracket}` : '',
    metadata?.description ? `説明: ${metadata.description}` : '',
    commanders.length > 0
      ? `統率者: ${commanders.map((entry) => entry.name).join(', ')}`
      : '',
    `メインデッキ: ${mainCardCount}枚 (${request.deck.entries.length}種)`,
    'デッキリスト (メインデッキのみ):',
    cards,
    candidates,
  ].filter(Boolean).join('\n');
}

function responseAnswer(response: OpenAiResponse): AgentAnswer {
  const content = (response.output ?? [])
    .flatMap((item) => item.content ?? [])
    .find((item) => item.type === 'output_text' && item.text !== undefined);
  // annotationの位置は元テキストのUTF-16 indexなのでtrimしてずらさない。
  const text = content?.text ?? response.output_text ?? '';
  const citations: AgentCitation[] = [];
  for (const annotation of content?.annotations ?? []) {
    if (annotation.type !== 'url_citation') continue;
    const citation = annotation.url_citation ?? annotation;
    if (
      typeof citation.start_index === 'number' &&
      typeof citation.end_index === 'number' &&
      typeof citation.url === 'string'
    ) {
      citations.push({
        startIndex: citation.start_index,
        endIndex: citation.end_index,
        url: citation.url,
        title: citation.title ?? citation.url,
      });
    }
  }
  return { text, citations };
}

function toolCalls(response: OpenAiResponse): AgentToolCall[] {
  return (response.output ?? [])
    .filter((item) => item.type === 'function_call' && item.call_id && item.name)
    .map((item) => ({
      id: item.call_id as string,
      name: item.name as string,
      arguments: item.arguments ?? '{}',
    }));
}

/** OpenAI Responses API用アダプター。SDKへ依存せずMV3 service workerから直接呼ぶ。 */
export class OpenAiAgentProvider implements AgentProvider {
  readonly id = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async run(
    request: AgentRequest,
    executeTool: ExecuteTool,
    signal?: AbortSignal,
  ): Promise<AgentAnswer> {
    const isCommander =
      request.deck.entries.some((entry) => entry.isCommander) ||
      /commander|edh/i.test(request.deck.metadata?.format ?? '');
    const instructions = [
      'あなたはMagic: The Gatheringのデッキ構築を支援する、根拠重視の協働エージェントです。回答は日本語で行ってください。',
      'まずユーザーの狙い・予算・プレイグループを必要に応じて確認し、断定しすぎません。',
      'カードの能力・フォーマット適法性は、提供されたScryfallツールで確認してください。',
      isCommander
        ? 'Commander/EDHデッキです。採用傾向はEDHREC、コンボはCommander Spellbook、禁止・ルールはmagic.wizards.com、カード詳細はScryfallを優先してください。'
        : '非Commanderデッキです。現在のメタゲームはMTGGoldfish・MTGTop8、フォーマットルールと禁止カードはmagic.wizards.com、カード詳細はScryfallを優先してください。統率者戦の前提やEDHRECの数値を持ち込まないでください。',
      'ツールは新しい根拠が必要な場合だけ使い、同じ検索・同じカードへの再問い合わせはしないでください。単純な助言では調査を繰り返さず、得た情報で回答してください。',
      '「メインデッキ」の枚数を正とし、候補リストやサイドボードをメインデッキ枚数へ加算しないでください。サイドボードはGame 2以降の交換用カードであり、Game 1の構成・速度・安定性を論じる際にメインデッキの採用カードとして扱わないでください。',
      '提案は「追加候補」「抜く候補」「理由」「注意点」の順に整理し、カード名は英語表記も添えてください。',
      '回答はMarkdownで整形してください。カード名は必ず `{{card:英語Oracle名}}` 形式で記述し、そのトークンをコードブロックやリンク内に入れないでください。UIが日本語名とカード画像へ置換するため、日本語名を自分で翻訳しないでください。',
      'Web検索の出典はAPIが付与するcitation annotationをUIで表示します。本文に生のcitation記法を説明として書かないでください。',
      'この拡張はデッキを自動編集しません。ユーザーの承認なく変更済みであるかのようには扱わないでください。',
    ].join('\n');
    const history = request.messages
      .map((message) => `${message.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${message.content}`)
      .join('\n\n');
    let input: unknown[] = [
      {
        role: 'user',
        content: `${deckText(request)}\n\n会話履歴:\n${history}`,
      },
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal?.aborted) throw new Error('AIの応答が時間切れになりました。');
      const response = await this.request({
        model: this.model,
        instructions,
        input,
        tools: [
          ...request.tools.map((tool) => ({
            type: 'function',
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
          {
            type: 'web_search',
            filters: {
              allowed_domains: [
                'edhrec.com',
                'scryfall.com',
                'commanderspellbook.com',
                'magic.wizards.com',
                'mtggoldfish.com',
                'mtgtop8.com',
              ],
            },
            search_context_size: 'medium',
          },
        ],
        tool_choice: 'auto',
      }, signal);
      for (const item of response.output ?? []) {
        if (item.type === 'web_search_call') {
          request.onProgress?.({
            kind: 'web_search',
            detail: item.action?.query
              ? `Web検索: ${item.action.query}`
              : 'Web検索: EDHREC / Commander Spellbook / 公式ルールを確認',
          });
        }
      }
      const calls = toolCalls(response);
      if (calls.length === 0) {
        const answer = responseAnswer(response);
        return answer.text
          ? answer
          : { text: '回答を生成できませんでした。もう一度お試しください。', citations: [] };
      }
      // Responses APIでは元の入力とモデルのfunction_call出力を残してから
      // function_call_outputを足す。そうしないと次のターンがデッキ文脈を失う。
      input.push(
        ...(response.output ?? []),
        ...(await Promise.all(
          calls.map(async (call) => {
            request.onProgress?.({ kind: 'scryfall', detail: toolProgress(call) });
            return {
              type: 'function_call_output',
              call_id: call.id,
              output: await executeTool(call),
            };
          }),
        )),
      );
    }
    return {
      text: `ツール呼び出しが${MAX_TOOL_ROUNDS}回に達しました。調査結果が十分にまとまらなかったため、質問をもう少し絞ってください。`,
      citations: [],
    };
  }

  private async request(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<OpenAiResponse> {
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new Error('AIの応答が180秒以内に完了しませんでした。もう一度お試しください。');
      }
      throw error;
    }
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 240)}`);
    }
    return (await res.json()) as OpenAiResponse;
  }
}

export type { AgentChatMessage };
