/* This filename sorts before migrations it depends on. node-pg-migrate is pinned to 7.9.1 because it orders by embedded timestamp. Changing the migration tool or major version requires renaming this file and updating every migration ledger; see ADR-031. */

export const up = async (pgm) => {
  pgm.createTable('idempotency_keys', {
    key: { type: 'text', notNull: true },
    run_id: {
      type: 'uuid',
      notNull: true,
      references: '"runs"',
      onDelete: 'CASCADE'
    },
    response: { type: 'jsonb', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Adding the composite primary key
  pgm.addConstraint('idempotency_keys', 'idempotency_keys_pkey', {
    primaryKey: ['run_id', 'key']
  });
};

export const down = async (pgm) => {
  pgm.dropTable('idempotency_keys');
};
