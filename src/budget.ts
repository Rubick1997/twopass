export class BudgetExceededError extends Error {
  constructor(spent: number, wanted: number, max: number) {
    super(
      `Cost cap reached: spent $${spent.toFixed(4)}, next step needs ~$${wanted.toFixed(4)}, cap is $${max.toFixed(2)}.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class Budget {
  readonly maxUsd: number | undefined;
  spentUsd: number;

  constructor(maxUsd: number | undefined, spentUsd = 0) {
    this.maxUsd = maxUsd;
    this.spentUsd = spentUsd;
  }

  assertCanSpend(estimateUsd = 0): void {
    if (this.maxUsd !== undefined && this.spentUsd + estimateUsd > this.maxUsd) {
      throw new BudgetExceededError(this.spentUsd, estimateUsd, this.maxUsd);
    }
  }

  charge(usd: number): void {
    this.spentUsd += usd;
  }
}
