// Static text imports also embed migrations in standalone builds.
import m0 from '../../db/migrations/001_init.sql' with { type: 'text' };
import m1 from '../../db/migrations/002_scale_and_settings.sql' with { type: 'text' };
import m2 from '../../db/migrations/003_retrieval_context.sql' with { type: 'text' };
import m3 from '../../db/migrations/004_canonical_uris.sql' with { type: 'text' };
import m4 from '../../db/migrations/005_change_notifications.sql' with { type: 'text' };

export const migrations: Record<string, string> = {
  '001_init.sql': m0,
  '002_scale_and_settings.sql': m1,
  '003_retrieval_context.sql': m2,
  '004_canonical_uris.sql': m3,
  '005_change_notifications.sql': m4,
};
