TRUNCATE TABLE public.stock_ticks;
DROP TABLE IF EXISTS public.virtual_trades;
VACUUM FULL ANALYZE public.stock_ticks;
VACUUM FULL ANALYZE public.stock_daily_prices;
