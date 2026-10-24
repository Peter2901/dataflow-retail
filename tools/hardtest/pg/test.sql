-- Real-Postgres test of supabase/setup.sql, the way Supabase runs it: the app's key is the "anon" role,
-- and PostgREST passes the request headers (x-shop-key) to SQL as request.headers.
\set ON_ERROR_STOP 0
create role anon nologin; create role authenticated nologin;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
\i /home/claude/dataflow-retail/supabase/setup.sql
\echo '--- run setup a second time (must be safe)'
\i /home/claude/dataflow-retail/supabase/setup.sql
grant all on records to anon, authenticated; grant usage, select on sequence records_seq to anon, authenticated;

-- helper: act as a device of a shop
create or replace function as_shop(k text) returns void language sql as $$ select set_config('request.headers', json_build_object('x-shop-key', k)::text, true) $$;
grant execute on function as_shop(text) to anon;

\echo '--- 1. shop A pushes rows (upsert, like the app)'
begin; set local role anon; select as_shop('shop_aaaaaaaaaaaaaaaaaaaaaaaa');
insert into records (table_name, id, store_id, counter, data, updated_at) values
 ('products', 'ta~P1', 'S1', 'T1', '{"id":"P1","name":"Atta","reorderMin":10,"active":true,"rack":"A1"}', 1),
 ('batches', 'ta~B1', 'S1', 'T1', '{"id":"B1","productId":"P1","batchNo":"X1","expiry":"2026-11-01","cost":40,"status":"active"}', 1),
 ('stockMoves', 'ta~T1:m1', 'S1', 'T1', '{"sid":"T1:m1","batchId":"B1","productId":"P1","qty":12}', 1),
 ('stockMoves', 'ta~T1:m2', 'S1', 'T1', '{"sid":"T1:m2","batchId":"B1","productId":"P1","qty":-5}', 1),
 ('sales', 'ta~s1', 'S1', 'T1', json_build_object('id','s1','no','S1T1/2627/000001','type','sale','ts',(extract(epoch from now())*1000)::bigint,'totals',json_build_object('payable',500,'taxable',476.19),'payments',json_build_array(json_build_object('mode','cash','amount',500)),'lines',json_build_array(json_build_object('name','Atta','qty',2,'total',500,'taxable',476.19,'cost',200)),'cashierName','Ravi')::jsonb, 1),
 ('sales', 'ta~s2', 'S1', 'T2', json_build_object('id','s2','no','S1T2/2627/000001','type','sale','ts',(extract(epoch from now())*1000)::bigint,'totals',json_build_object('payable',300),'payments',json_build_array(json_build_object('mode','upi','amount',300)),'lines','[]'::json)::jsonb, 1),
 ('journal', 'ta~j1', 'S1', 'T1', '{"id":"j1","lines":[{"acc":"cust:C1","dr":250},{"acc":"sales","cr":250}]}', 1)
on conflict (table_name, id) do update set data = excluded.data, updated_at = excluded.updated_at, counter = excluded.counter;
select 'A sees', count(*) from records;
commit;

\echo '--- 2. shop B cannot see or change shop A rows'
begin; set local role anon; select as_shop('shop_bbbbbbbbbbbbbbbbbbbbbbbb');
select 'B sees (must be 0)', count(*) from records;
commit;
begin; set local role anon; select as_shop('shop_bbbbbbbbbbbbbbbbbbbbbbbb');
insert into records (table_name, id, store_id, counter, data, updated_at) values ('products', 'ta~P1', 'S1', 'T9', '{"id":"P1","name":"HACKED"}', 2)
on conflict (table_name, id) do update set data = excluded.data;
commit;
begin; set local role anon; select as_shop('shop_bbbbbbbbbbbbbbbbbbbbbbbb');
update records set data = '{"name":"HACKED"}' where id = 'ta~P1';
select 'B update touched (must be 0)';
commit;
begin; set local role anon; select as_shop('');
select 'no key sees (must be 0)', count(*) from records;
commit;
begin; set local role anon; select as_shop('shop_aaaaaaaaaaaaaaaaaaaaaaaa');
select 'A product name still', data->>'name' from records where id = 'ta~P1';
commit;

\echo '--- 3. every save gets a new, higher row number'
begin; set local role anon; select as_shop('shop_aaaaaaaaaaaaaaaaaaaaaaaa');
select 'seq before', seq from records where id = 'ta~P1';
insert into records (table_name, id, store_id, counter, data, updated_at) values ('products', 'ta~P1', 'S1', 'T1', '{"id":"P1","name":"Atta 5kg","reorderMin":10,"active":true}', 3)
on conflict (table_name, id) do update set data = excluded.data, updated_at = excluded.updated_at;
select 'seq after (higher)', seq, data->>'name' from records where id = 'ta~P1';
select 'pull order', string_agg(table_name || ':' || seq, ', ' order by seq) from records where table_name <> 'counter_status' and seq > 0;
commit;

\echo '--- 4. owner app numbers'
begin; set local role anon; select as_shop('shop_aaaaaaaaaaaaaaaaaaaaaaaa');
select 'owner_today', owner_today('S1', (extract(epoch from date_trunc('day', now()))*1000)::bigint, (extract(epoch from now())*1000)::bigint) - 'recent' - 'hours';
select 'owner_alerts', owner_alerts('S1', (extract(epoch from now())*1000)::bigint);
commit;

\echo '--- 5. the download query uses an index (shop, seq)'
set enable_seqscan = off;
begin; set local role anon; select as_shop('shop_aaaaaaaaaaaaaaaaaaaaaaaa');
explain (costs off) select table_name, id, store_id, counter, data, seq from records where table_name <> 'counter_status' and seq > 0 order by seq limit 1000;
commit;
