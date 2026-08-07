import { render, type Ast } from '@spintax/core';

export interface RenderOpOptions {
  context?: Record<string, string>;
  seed?: number | string;
  locale?: string;
  postProcess?: boolean;
}

/** One render, engine defaults preserved (postProcess on; lenient on content). */
export function renderOp(template: string | Ast, opts: RenderOpOptions): string {
  return render(template, {
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
    ...(opts.postProcess !== undefined ? { postProcess: opts.postProcess } : {}),
  });
}
