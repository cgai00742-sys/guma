-- Guma: remember how the shop gets paid.
--
-- The setup wizard asks "How do you mostly get paid?" -- clients, selling,
-- or both -- and uses the answer to decide which questions follow. It never
-- stored it. So every return to setup found the question unanswered and
-- opened on it again, and the quoting or selling questions that hang off
-- it disappeared, because without the answer none of them applied. From
-- the chair that reads as "I answered all of this and it asks me again",
-- and "finish setup did nothing".
--
-- Null means not answered yet, which is different from any of the three.
alter table shops add column sell_branch text
  check (sell_branch is null or sell_branch in ('clients', 'selling', 'both'));
