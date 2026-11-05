/**
 * Stock rule D3: a sale may never take recorded stock below zero.
 * Cart lines are NOT merged per product, so quantities are summed here before comparing.
 * The server (`decrementForSale`) is the authority; this only lets the UI warn early.
 */
export interface StockRequest {
  productId: number;
  quantityMinor: number;
}
export interface StockProblem {
  productId: number;
  availableMinor: number;
  requestedMinor: number;
}

export function findStockProblems(
  requests: StockRequest[],
  stock: ReadonlyMap<number, number>,
): StockProblem[] {
  const wanted = new Map<number, number>();
  for (const r of requests) wanted.set(r.productId, (wanted.get(r.productId) ?? 0) + r.quantityMinor);
  const problems: StockProblem[] = [];
  for (const [productId, requestedMinor] of wanted) {
    const availableMinor = stock.get(productId) ?? 0;
    if (requestedMinor > availableMinor) problems.push({ productId, availableMinor, requestedMinor });
  }
  return problems;
}
