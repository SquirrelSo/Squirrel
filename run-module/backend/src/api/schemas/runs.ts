export const createRunSchema = {
  body: {
    type: 'object',
    properties: {
      started_at: { type: 'string', format: 'date-time' },
      // The phone's IANA time zone: the run's calendar day follows it (daily XP cap).
      timezone: { type: 'string', maxLength: 64 },
    },
    additionalProperties: true,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
      },
      required: ['run_id'],
    },
  },
};

export const uploadPointsSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  body: {
    type: 'object',
    properties: {
      idempotency_key: { type: 'string' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            seq: { type: 'integer', minimum: 0 },
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
            accuracy_m: { type: 'number' },
            recorded_at: { type: 'string', format: 'date-time' },
            is_mock: { type: 'boolean', nullable: true },
          },
          required: ['seq', 'lat', 'lng', 'accuracy_m', 'recorded_at'],
        },
      },
    },
    required: ['idempotency_key', 'points'],
  },
  response: {
    200: {
      type: 'object',
      properties: {
        accepted: { type: 'integer' },
        duplicates_ignored: { type: 'integer' },
      },
    },
    202: {
      type: 'object',
      properties: {
        accepted: { type: 'integer' },
        duplicates_ignored: { type: 'integer' },
      },
    },
  },
};

export const finishRunSchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
  response: {
    202: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['run_id', 'status'],
    },
  },
};

export const getRunSummarySchema = {
  params: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
    required: ['id'],
  },
  response: {
    200: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        status: { type: 'string' },
        started_at: { type: 'string', format: 'date-time' },
        territory_reason: { type: ['string', 'null'] },
        stats: {
          type: 'object',
          properties: {
            distance_m: { type: 'number', nullable: true },
            moving_time_s: { type: 'integer', nullable: true },
            elapsed_time_s: { type: 'integer', nullable: true },
          },
        },
        territory: {
          type: ['object', 'null'],
          properties: {
            id: { type: 'string' },
            area_m2: { type: 'number' },
            claimed_at: { type: 'string', format: 'date-time' },
            geometry: { type: 'object', additionalProperties: true },
          },
        },
        rejection: {
          type: ['object', 'null'],
          properties: {
            reason: { type: 'string' },
            detail: { type: ['string', 'null'] },
            rejected_at: { type: 'string', format: 'date-time' },
          },
        },
        score: {
          type: ['object', 'null'],
          properties: {
            aggregate: { type: 'number' },
            band: { type: 'string' },
            decisive_layer: { type: ['string', 'null'] },
          },
          required: ['aggregate', 'band']
        },
      },
      required: ['run_id', 'status', 'started_at', 'territory_reason', 'stats', 'territory', 'rejection', 'score'],
    },
  },
};

