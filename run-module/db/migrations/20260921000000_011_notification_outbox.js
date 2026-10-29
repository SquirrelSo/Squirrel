exports.up = async (pgm) => {
  pgm.sql(`
    CREATE TABLE notification_outbox (
      id              uuid PRIMARY KEY,
      user_id         uuid NOT NULL,
      event_type      text NOT NULL,
      payload         jsonb NOT NULL,
      source_module   text NOT NULL DEFAULT 'run_module',
      created_at      timestamptz NOT NULL DEFAULT now(),
      enqueued_at     timestamptz
    );
    CREATE INDEX notification_outbox_pending_idx
      ON notification_outbox (created_at) WHERE enqueued_at IS NULL;
  `);
};

exports.down = async (pgm) => {
  pgm.sql("DROP TABLE notification_outbox;");
};
