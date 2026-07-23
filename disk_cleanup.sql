-- === DISK CLEANUP SCRIPT ===
-- Run this in Supabase SQL Editor to free up disk space

-- 1. TRUNCATE stock_ticks table (biggest space hog - millions of rows)
-- This table stores ~2,376 rows per minute during market hours = ~120MB/day
TRUNCATE TABLE public.stock_ticks;

-- 2. Drop virtual_trades table (removed from frontend, no longer needed)
DROP TABLE IF EXISTS public.virtual_trades;

-- 3. Delete old stock_daily_prices (keep only last 30 days)
DELETE FROM public.stock_daily_prices 
  WHERE trade_date < CURRENT_DATE - INTERVAL '30 days';

-- 4. Delete old watchlists/saved_signals/trade_journal/user_alerts for deleted users
DELETE FROM public.watchlists WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.saved_signals WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.trade_journal WHERE user_id NOT IN (SELECT id FROM auth.users);
DELETE FROM public.user_alerts WHERE user_id NOT IN (SELECT id FROM auth.users);

-- 5. Reclaim disk space (CRITICAL - without this, deleted rows don't free space)
VACUUM FULL ANALYZE public.stock_ticks;
VACUUM FULL ANALYZE public.stock_daily_prices;
VACUUM FULL ANALYZE public.nse_symbols;

-- 6. Check disk usage after cleanup
SELECT 
  schemaname || '.' || relname AS table_name,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  n_live_tup AS row_count
FROM pg_stat_user_tables 
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10;
