-- =====================================================
-- NSE Trading Dashboard — Supabase Schema (FIXED)
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Copy ALL of this and paste, then click RUN
-- =====================================================

-- 1. PROFILES TABLE
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  preferences JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. WATCHLISTS TABLE
CREATE TABLE IF NOT EXISTS public.watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My Watchlist',
  symbols TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. SAVED SIGNALS TABLE
CREATE TABLE IF NOT EXISTS public.saved_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  price NUMERIC,
  buy_score INT DEFAULT 0,
  sell_score INT DEFAULT 0,
  sl NUMERIC,
  tp1 NUMERIC,
  tp2 NUMERIC,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. TRADE JOURNAL TABLE
CREATE TABLE IF NOT EXISTS public.trade_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'HOLD')),
  entry_price NUMERIC,
  exit_price NUMERIC,
  quantity INT DEFAULT 0,
  pnl NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

-- 5. USER ALERTS TABLE
CREATE TABLE IF NOT EXISTS public.user_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  alert_condition TEXT NOT NULL,
  target_price NUMERIC,
  active BOOLEAN DEFAULT TRUE,
  triggered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  triggered_at TIMESTAMPTZ
);

-- ===== AUTO-CREATE PROFILE ON SIGNUP =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ===== ROW LEVEL SECURITY =====
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_alerts ENABLE ROW LEVEL SECURITY;

-- Profiles
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Watchlists
DROP POLICY IF EXISTS "Users can view own watchlists" ON public.watchlists;
CREATE POLICY "Users can view own watchlists" ON public.watchlists FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own watchlists" ON public.watchlists;
CREATE POLICY "Users can create own watchlists" ON public.watchlists FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own watchlists" ON public.watchlists;
CREATE POLICY "Users can update own watchlists" ON public.watchlists FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own watchlists" ON public.watchlists;
CREATE POLICY "Users can delete own watchlists" ON public.watchlists FOR DELETE USING (auth.uid() = user_id);

-- Saved Signals
DROP POLICY IF EXISTS "Users can view own signals" ON public.saved_signals;
CREATE POLICY "Users can view own signals" ON public.saved_signals FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own signals" ON public.saved_signals;
CREATE POLICY "Users can create own signals" ON public.saved_signals FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own signals" ON public.saved_signals;
CREATE POLICY "Users can delete own signals" ON public.saved_signals FOR DELETE USING (auth.uid() = user_id);

-- Trade Journal
DROP POLICY IF EXISTS "Users can view own trades" ON public.trade_journal;
CREATE POLICY "Users can view own trades" ON public.trade_journal FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own trades" ON public.trade_journal;
CREATE POLICY "Users can create own trades" ON public.trade_journal FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own trades" ON public.trade_journal;
CREATE POLICY "Users can update own trades" ON public.trade_journal FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own trades" ON public.trade_journal;
CREATE POLICY "Users can delete own trades" ON public.trade_journal FOR DELETE USING (auth.uid() = user_id);

-- Alerts
DROP POLICY IF EXISTS "Users can view own alerts" ON public.user_alerts;
CREATE POLICY "Users can view own alerts" ON public.user_alerts FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can create own alerts" ON public.user_alerts;
CREATE POLICY "Users can create own alerts" ON public.user_alerts FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can update own alerts" ON public.user_alerts;
CREATE POLICY "Users can update own alerts" ON public.user_alerts FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own alerts" ON public.user_alerts;
CREATE POLICY "Users can delete own alerts" ON public.user_alerts FOR DELETE USING (auth.uid() = user_id);

-- ===== INDEXES =====
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON public.watchlists(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_signals_user ON public.saved_signals(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_journal_user ON public.trade_journal(user_id);
CREATE INDEX IF NOT EXISTS idx_user_alerts_user ON public.user_alerts(user_id);
