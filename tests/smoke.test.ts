import { describe, it, expect, afterAll } from 'vitest';
import { freshDb, cleanup, makeProduct, stockOf } from './helpers';
afterAll(cleanup);
describe('harness', () => {
  it('creates a DB and a stocked product', () => {
    freshDb();
    const p = makeProduct({ price: 450, stock: 10 });
    expect(stockOf(p.id)).toBe(10);
  });
});
