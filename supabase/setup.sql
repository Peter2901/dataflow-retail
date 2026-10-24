-- DataFlow Retail — Supabase setup. Safe to run more than once.
-- Supabase › SQL Editor › paste › Run.

-- 1. One shared table: every counter sends its rows here and reads the others'.
create table if not exists records (
  table_name text not null,
  id text not null,
  store_id text,
  counter text,
  data jsonb,
  updated_at bigint,
  seq bigint,
  server_ts timestamptz,
  primary key (table_name, id)
);
alter table records add column if not exists seq bigint;
alter table records add column if not exists server_ts timestamptz;

-- 2. The server numbers every saved row (counters never depend on their own clocks).
create sequence if not exists records_seq;
create or replace function records_bump_seq() returns trigger language plpgsql set search_path = public as $$
begin new.seq := nextval('records_seq'); new.server_ts := now(); return new; end $$;
drop trigger if exists records_seq_trg on records;
create trigger records_seq_trg before insert or update on records for each row execute function records_bump_seq();
create index if not exists records_pull_seq on records (store_id, seq);
create index if not exists records_sales_ts on records (store_id, ((data->>'ts')::bigint)) where table_name = 'sales';

-- 3. Access for the app's publishable key, one shop at a time.
-- Each shop's devices send their shop key in the x-shop-key header; a row belongs to the shop
-- whose key was used to save it, and a shop can only read or change its own rows.
-- A store that has its own Supabase project needs no shop key (its rows have shop = '').
create or replace function req_shop() returns text language sql stable set search_path = public as $$
  select coalesce(nullif(current_setting('request.headers', true), '')::json->>'x-shop-key', '')
$$;
alter table records add column if not exists shop text not null default '';
alter table records alter column shop set default req_shop();
create index if not exists records_shop_pull on records (shop, store_id, seq);
create index if not exists records_shop_seq on records (shop, seq);          -- devices download every branch of their shop
alter table records enable row level security;
drop policy if exists "app read" on records;
drop policy if exists "app insert" on records;
drop policy if exists "app update" on records;
create policy "app read" on records for select using (shop = req_shop());
create policy "app insert" on records for insert with check (shop = req_shop());
create policy "app update" on records for update using (shop = req_shop()) with check (shop = req_shop());

-- 4. Owner phone app: today's numbers, worked out in the database (a few KB per refresh).
create or replace function owner_today(p_store text, p_from bigint, p_now bigint, p_tz text default 'Asia/Kolkata')
returns jsonb language sql stable set search_path = public as $$
with
sl as (
  select counter, id, data d, (data->>'ts')::bigint ts,
         case when data->>'type' = 'return' then -1 else 1 end sg,
         coalesce((data#>>'{totals,payable}')::numeric, 0) amt
  from records
  where table_name = 'sales' and store_id = p_store and (data->>'ts')::bigint >= p_from - 86400000
),
td as (select * from sl where ts >= p_from),
yd as (select * from sl where ts < p_now - 86400000),
pay as (
  select coalesce(p->>'mode', 'other') mode, sum(td.sg * coalesce((p->>'amount')::numeric, 0)) amt
  from td, jsonb_array_elements(coalesce(td.d->'payments', '[]'::jsonb)) p group by 1
),
hr as (
  select extract(hour from to_timestamp(ts / 1000.0) at time zone p_tz)::int h, sum(sg * amt) amt from td group by 1
),
items as (
  select l->>'name' as name, sum(coalesce((l->>'qty')::numeric, 0)) qty, sum(coalesce((l->>'total')::numeric, 0)) amt
  from td, jsonb_array_elements(coalesce(td.d->'lines', '[]'::jsonb)) l
  where td.d->>'type' = 'sale' group by 1 order by 3 desc limit 5
),
hb as (select counter, data d, server_ts from records where table_name = 'counter_status' and store_id = p_store),
cs as (
  select counter, sum(sg * amt) amt, count(*) filter (where d->>'type' = 'sale') bills,
         (array_agg(d->>'cashierName' order by ts desc))[1] cashier
  from td group by counter
),
ctrs as (select counter from hb union select counter from cs),
ord as (
  select data->>'no' as no, data->>'customerName' cust, data->>'status' status, coalesce(data->>'mode', data->>'type') typ,
         jsonb_array_length(coalesce(data->'items', '[]'::jsonb)) n, (data->>'createdAt')::bigint created
  from records where table_name = 'orders' and store_id = p_store and data->>'status' in ('new', 'packing', 'ready')
),
recent as (
  select id, d->>'no' as no, ts, counter, d->>'type' typ, d->>'customerName' cust, d->>'customerPhone' phone,
         d->>'cashierName' cashier, sg * amt amt,
         (select string_agg(distinct p->>'mode', ' + ') from jsonb_array_elements(coalesce(d->'payments', '[]'::jsonb)) p) modes
  from td order by ts desc limit 80
)
select jsonb_build_object(
  'sales', coalesce((select sum(sg * amt) from td), 0),
  'bills', (select count(*) from td where d->>'type' = 'sale'),
  'returns', (select count(*) from td where d->>'type' = 'return'),
  'ydaySameTime', coalesce((select sum(sg * amt) from yd), 0),
  'profit', coalesce((select sum(td.sg * (coalesce((l->>'taxable')::numeric, 0) - coalesce((l->>'qty')::numeric, 0) * coalesce((l->>'cost')::numeric, 0)))
                      from td, jsonb_array_elements(coalesce(td.d->'lines', '[]'::jsonb)) l), 0),
  'pay', coalesce((select jsonb_object_agg(mode, amt) from pay), '{}'::jsonb),
  'hours', coalesce((select jsonb_object_agg(h::text, amt) from hr), '{}'::jsonb),
  'top', coalesce((select jsonb_agg(to_jsonb(i)) from items i), '[]'::jsonb),
  'counters', coalesce((select jsonb_agg(jsonb_build_object(
        'counter', c.counter,
        'lastSeen', (extract(epoch from hb.server_ts) * 1000)::bigint,
        'sales', coalesce(cs.amt, 0), 'bills', coalesce(cs.bills, 0),
        'user', coalesce(nullif(hb.d->>'user', ''), cs.cashier),
        'pending', coalesce((hb.d->>'pending')::int, 0)
      ) order by c.counter)
      from ctrs c left join cs on cs.counter = c.counter left join hb on hb.counter = c.counter), '[]'::jsonb),
  'orders', coalesce((select jsonb_agg(to_jsonb(o) order by o.created) from ord o), '[]'::jsonb),
  'recent', coalesce((select jsonb_agg(to_jsonb(r) order by r.ts desc) from recent r), '[]'::jsonb),
  'serverNow', (extract(epoch from now()) * 1000)::bigint
);
$$;

-- 5. Owner phone app: stock alerts and money owed (stock is the sum of all stock moves).
create or replace function owner_alerts(p_store text, p_now bigint, p_tz text default 'Asia/Kolkata')
returns jsonb language sql stable set search_path = public as $$
with
today as (select (to_timestamp(p_now / 1000.0) at time zone p_tz)::date d),
mv as (
  select data->>'batchId' bid, sum(coalesce((data->>'qty')::numeric, 0)) q
  from records where table_name = 'stockMoves' and store_id = p_store and data->>'batchId' is not null group by 1
),
-- Joined on the app's own ids (data->>'id'): with a shop key the cloud row id carries a shop tag.
bt as (
  select r.data->>'id' id, r.data d, coalesce(mv.q, 0) q
  from records r left join mv on mv.bid = r.data->>'id'
  where r.table_name = 'batches' and r.store_id = p_store and coalesce(r.data->>'status', 'active') = 'active'
),
pr as (select data->>'id' id, data d from records where table_name = 'products'),
oh as (select d->>'productId' pid, sum(q) q from bt group by 1),
low as (
  select pr.d->>'name' as name, pr.d->>'rack' rack, round(coalesce(oh.q, 0), 3) q, nullif(pr.d->>'reorderMin', '')::numeric rmin
  from pr left join oh on oh.pid = pr.id
  where coalesce(pr.d->>'active', 'true') <> 'false'
    and nullif(pr.d->>'reorderMin', '') is not null
    and coalesce(oh.q, 0) <= nullif(pr.d->>'reorderMin', '')::numeric
),
ex as (
  select pr.d->>'name' as name, pr.d->>'rack' rack, bt.d->>'batchNo' batch, round(bt.q, 3) q,
         nullif(bt.d->>'expiry', '')::date - (select d from today) dl,
         round(bt.q * coalesce((bt.d->>'cost')::numeric, 0), 2) val
  from bt left join pr on pr.id = bt.d->>'productId'
  where bt.q > 0.0001 and nullif(bt.d->>'expiry', '') is not null
),
ex30 as (select * from ex where dl <= 30),
jl as (
  select l->>'acc' acc, sum(coalesce((l->>'dr')::numeric, 0) - coalesce((l->>'cr')::numeric, 0)) bal
  from records r, jsonb_array_elements(coalesce(r.data->'lines', '[]'::jsonb)) l
  where r.table_name = 'journal' and r.store_id = p_store and l->>'acc' like 'cust:%' group by 1
)
select jsonb_build_object(
  'low', coalesce((select jsonb_agg(to_jsonb(x) order by x.q) from (select * from low order by q limit 100) x), '[]'::jsonb),
  'lowCount', (select count(*) from low),
  'expired', coalesce((select jsonb_agg(to_jsonb(x) order by x.dl) from (select * from ex30 where dl < 0 order by dl limit 100) x), '[]'::jsonb),
  'expiring', coalesce((select jsonb_agg(to_jsonb(x) order by x.dl) from (select * from ex30 where dl >= 0 order by dl limit 100) x), '[]'::jsonb),
  'expiredValue', coalesce((select sum(val) from ex30 where dl < 0), 0),
  'expiringValue', coalesce((select sum(val) from ex30 where dl >= 0), 0),
  'custDue', coalesce((select sum(bal) from jl where bal > 0), 0),
  'serverNow', (extract(epoch from now()) * 1000)::bigint
);
$$;

grant execute on function owner_today(text, bigint, bigint, text) to anon, authenticated;
grant execute on function owner_alerts(text, bigint, text) to anon, authenticated;
