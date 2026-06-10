exports.up = (pgm) => {
  pgm.sql(`DELETE FROM lead_status_config WHERE key = 'ROUGH_ESTIMATE_SENT'`);
};

exports.down = (pgm) => {
  pgm.sql(`
    INSERT INTO lead_status_config (key, label, sort_order, excluded_from_sales)
    VALUES ('ROUGH_ESTIMATE_SENT', 'Rough estimate sent', 50, false)
    ON CONFLICT (key) DO NOTHING
  `);
};
