import { beforeEach, describe, expect, it } from 'vitest';
import { useCart, type CartItem } from '../src/renderer/stores/cartStore';

const item: CartItem = {
  product: {
    id: 1,
    name: 'Chicken',
    nameAr: null,
    categoryId: 1,
    sellingUnit: 'WEIGHT',
    currentPrice: 450,
    priceCurrency: 'USD',
    currentCost: null,
    lowStockThreshold: null,
    imageDataUrl: null,
    notes: null,
    active: true,
  },
  quantityMinor: 1350,
  unitPriceMinor: 600,
  priceCurrency: 'USD',
  directFinalPrice: true,
  lineTotalMinor: 600,
};

describe('Cart store', () => {
  beforeEach(() => useCart.getState().clear());

  it('scales a direct final price with edited weight', () => {
    useCart.getState().addItem(item);
    useCart.getState().updateItemQty(0, 2700);
    expect(useCart.getState().items[0].lineTotalMinor).toBe(1200);
  });

  it('updates the selected cart line without changing other lines', () => {
    useCart.getState().addItem(item);
    useCart.getState().addItem({ ...item, quantityMinor: 1000, lineTotalMinor: 450 });
    useCart.getState().updateItem(0, { ...item, quantityMinor: 2000, lineTotalMinor: 900 });
    expect(useCart.getState().items.map((line) => line.lineTotalMinor)).toEqual([900, 450]);
  });
});
