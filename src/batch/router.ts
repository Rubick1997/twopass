import { ANTHROPIC_BATCH_ID_PREFIX, isAnthropicDirect } from './anthropic.ts';
import type { BatchHandle, BatchProvider, BatchRequest, BatchStatus, WaitOptions } from './provider.ts';

/** Claude models go to the Anthropic provider, everything else to OpenRouter; batch IDs decide polling. */
export class RoutingBatchProvider implements BatchProvider {
  private readonly openRouter: BatchProvider;
  private readonly anthropic: BatchProvider | undefined;

  constructor(openRouter: BatchProvider, anthropic?: BatchProvider) {
    this.openRouter = openRouter;
    this.anthropic = anthropic;
  }

  private needAnthropic(what: string): BatchProvider {
    if (!this.anthropic) throw new Error(`${what} uses Anthropic directly: set ANTHROPIC_API_KEY`);
    return this.anthropic;
  }

  private byId(id: string): BatchProvider {
    return id.startsWith(ANTHROPIC_BATCH_ID_PREFIX) ? this.needAnthropic(`Batch ${id}`) : this.openRouter;
  }

  submit(model: string, requests: BatchRequest[], onSubmitted: (h: BatchHandle) => void): Promise<BatchHandle[]> {
    const p = isAnthropicDirect(model) ? this.needAnthropic(`Model ${model}`) : this.openRouter;
    return p.submit(model, requests, onSubmitted);
  }

  poll(id: string): Promise<BatchStatus> {
    return this.byId(id).poll(id);
  }

  waitForTerminal(id: string, opts?: WaitOptions): Promise<BatchStatus> {
    return this.byId(id).waitForTerminal(id, opts);
  }
}
