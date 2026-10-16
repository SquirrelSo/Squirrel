export const LeaderboardResponseSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string' },
    window: { type: 'string' },
    metric: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number' },
          user_id: { type: 'string' },
          score: { type: 'number' }
        },
        required: ['rank', 'user_id', 'score']
      }
    },
    me: {
      type: ['object', 'null'],
      properties: {
        rank: { type: 'number' },
        score: { type: 'number' }
      },
      required: ['rank', 'score']
    },
    next_cursor: { type: ['string', 'null'] },
    total_ranked: { type: 'number' }
  },
  required: ['scope', 'window', 'metric', 'entries', 'me', 'next_cursor', 'total_ranked']
};
