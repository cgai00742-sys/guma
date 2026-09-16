-- Work with no client.
--
-- Guma has only ever been able to see a job with a client on the other end
-- of it. Every test print, every failed experiment, every hour spent
-- learning a material or designing something to sell yourself has been
-- invisible to it -- and invisible is the generous word. It is worse than
-- that: a shop measuring only client jobs sees healthy margins on every one
-- of them while the business loses money on the third of its capacity that
-- was never billed. The report says you are fine. The bank says otherwise.
-- Both are reading real numbers.
--
-- So an in-house job is a real job here. It has runs, hours, material draw,
-- parts and failures like any other, and it is excluded from everything
-- that implies somebody owes money: no quote, no deposit, no receivable, no
-- client.
--
-- WHY client_id STAYS NOT NULL.
--
-- The obvious shape is a nullable client_id. It is also the one thing this
-- schema cannot do cheaply: nine tables cascade off jobs, and SQLite cannot
-- relax a NOT NULL in place, so it would mean rebuilding the most
-- referenced table in the database -- with foreign keys disabled, across
-- print_runs, work_log, payments and six more -- to gain a NULL. Every
-- migration in this project so far has been additive, on purpose, and this
-- is a bad place to break that streak for a cosmetic win.
--
-- Instead each shop gets exactly one hidden client row, flagged system = 1,
-- and in-house jobs point at it. The FLAG is the thing that matters, not
-- the null: every client-facing query filters system rows out, so it never
-- appears in the client list, the client count, the receivables, the
-- pickers or search. From the shop's side there is no client on the job,
-- which is the behaviour that was actually asked for. The storage is an
-- implementation detail, and a nullable column can replace it later without
-- changing a single screen.
alter table clients add column system integer not null default 0;

-- 'client'  work somebody is paying for -- everything Guma did before this.
-- 'inhouse' work the shop does for itself: R&D, test prints, calibration,
--           samples, and designing its own products.
--
-- Defaulting to 'client' is right for the same reason 0011's archived
-- default was: every job that already exists was billed work, so "we did
-- not ask" and "client" really are the same answer here.
alter table jobs add column kind text not null default 'client'
  check (kind in ('client','inhouse'));

-- The two queries this adds are "show me the in-house jobs" and "total the
-- unbilled hours", both of which filter on kind within a shop.
create index idx_jobs_shop_kind on jobs (shop_id, kind);

-- Only one system client per shop, enforced rather than assumed -- a second
-- one would split the unbilled totals in half and nothing would say so.
create unique index idx_clients_system on clients (shop_id) where system = 1;
