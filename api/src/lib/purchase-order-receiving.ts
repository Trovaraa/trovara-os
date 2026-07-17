export type ReceiptProgress = {
  quantityOrdered: number
  quantityReceived: number
}

export function purchaseOrderStatusAfterReceipt(
  lines: ReceiptProgress[],
): 'partially_received' | 'received' {
  return lines.every((line) => line.quantityReceived >= line.quantityOrdered)
    ? 'received'
    : 'partially_received'
}

export function receiptQuantityIsValid(
  line: ReceiptProgress,
  quantity: number,
): boolean {
  return Number.isInteger(quantity) && quantity > 0
    && line.quantityReceived + quantity <= line.quantityOrdered
}
