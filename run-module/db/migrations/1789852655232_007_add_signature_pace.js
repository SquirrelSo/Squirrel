exports.up = (pgm) => {
  pgm.addColumns('run_signatures', {
    duration_s: { type: 'integer' },
    mean_speed_ms: { type: 'double precision' }
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('run_signatures', ['duration_s', 'mean_speed_ms']);
};
