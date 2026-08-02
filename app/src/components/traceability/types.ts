export type TraceabilityLot = {
  id: string
  farmSlug: string
  lotCode: string
  publicToken?: string
  productId?: string | null
  plotId?: string | null
  plotName?: string | null
  zoneName?: string | null
  productName: string
  quantityKg: number
  unit?: string
  harvestedAt: string
  createdAt: string
  publicNotes?: string | null
  internalNotes?: string | null
  photoUrl?: string | null
  verificationStatus: string
  reportedByName?: string | null
  verifiedByName?: string | null
  verifiedAt?: string | null
  orderId?: string | null
  orderReference?: string | null
  orderSource?: string | null
}

export type TraceabilityPlotOption = {
  id: string
  name: string
  zoneName?: string | null
}
