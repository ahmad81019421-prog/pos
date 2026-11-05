/**
 * Cart state — persisted in-memory only (NOT in DB until sale is completed/suspended).
 *
 * PRD section 77: cart must be safe from accidental loss. We keep it in a Zustand store
 * with simple undo (remove last item) and a "suspend" action that pushes the current cart
 * to the suspended_sale DB row (only one allowed).
 */

import { create } from 'zustand';
import type { CartLineInput, ProductDTO } from '@shared/types/index';
import {
  computeLineTotal,
  formatUsd,
  formatLbp,
  mulDivRound,
} from '@shared/money/index';

export interface CartItem {
  product: ProductDTO;
  quantityMinor: number;
  unitPriceMinor: number;
  priceCurrency: 'USD' | 'LBP';
  directFinalPrice: boolean;
  lineTotalMinor: number;
}

interface CartState {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (index: number) => void;
  updateItemQty: (index: number, quantityMinor: number) => void;
  updateItem: (index: number, item: CartItem) => void;
  clear: () => void;
  totals: () => { usdCents: number; lbp: number };
}

export const useCart = create<CartState>((set, get) => ({
  items: [],
  addItem: (item) =>
    set((state) => {
      // If the same product is already in the cart, we DON'T merge — the cashier may have
      // different weights/prices per line. Just append.
      return { items: [...state.items, item] };
    }),
  removeItem: (index) =>
    set((state) => ({
      items: state.items.filter((_, i) => i !== index),
    })),
  updateItemQty: (index, quantityMinor) =>
    set((state) => {
      const items = state.items.map((item, i) => {
        if (i !== index) return item;
        const lineTotalMinor = item.directFinalPrice
          ? mulDivRound(item.lineTotalMinor, quantityMinor, item.quantityMinor)
          : computeLineTotal(
              quantityMinor,
              item.unitPriceMinor,
              item.product.sellingUnit,
              item.priceCurrency,
            );
        return { ...item, quantityMinor, lineTotalMinor };
      });
      return { items };
    }),
  updateItem: (index, item) =>
    set((state) => ({
      items: state.items.map((current, i) => (i === index ? item : current)),
    })),
  clear: () => set({ items: [] }),
  totals: () => {
    const items = get().items;
    let usdCents = 0;
    let lbp = 0;
    for (const item of items) {
      if (item.priceCurrency === 'USD') usdCents += item.lineTotalMinor;
      else lbp += item.lineTotalMinor;
    }
    return { usdCents, lbp };
  },
}));

/**
 * Convert cart items to CartLineInput[] for the completeSale API.
 */
export function cartToLineInputs(items: CartItem[]): CartLineInput[] {
  return items.map((item) => ({
    productId: item.product.id,
    quantityMinor: item.quantityMinor,
    unitPriceMinor: item.unitPriceMinor,
    priceCurrency: item.priceCurrency,
    directFinalPrice: item.directFinalPrice,
    lineTotalMinor: item.lineTotalMinor,
  }));
}

export function formatCartTotal(usdCents: number, lbp: number): string {
  const parts: string[] = [];
  if (usdCents > 0) parts.push(formatUsd(usdCents));
  if (lbp > 0) parts.push(formatLbp(lbp));
  if (!parts.length) return '$0.00';
  return parts.join(' + ');
}
