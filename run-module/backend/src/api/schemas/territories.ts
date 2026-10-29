export const TerritorySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    area_m2: { type: 'number' },
    claimed_at: { type: 'string', format: 'date-time' },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
    state: { type: 'string' },
    geometry: { type: 'object', additionalProperties: true },
  },
  required: ['id', 'area_m2', 'claimed_at', 'expires_at', 'state', 'geometry'],
};

export const TerritoriesMineResponseSchema = {
  type: 'object',
  properties: {
    territories: {
      type: 'array',
      items: TerritorySchema,
    },
    truncated: { type: 'boolean' },
  },
  required: ['territories', 'truncated'],
};
