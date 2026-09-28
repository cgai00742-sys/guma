-- Guma: why this version costs more than the one they accepted.
--
-- THE RULE THIS SERVES (CG's, on the record): the first quote can be broad,
-- but once a final estimate has been ACCEPTED the price may rise by at most
-- 10%, only for reasons the client caused, and the tool warns rather than
-- blocks -- because a shop that cannot record what actually happened will
-- keep a second set of numbers somewhere the tool cannot see.
--
-- Nothing here stores the ceiling: it is the accepted version's own total,
-- which is already on the accepted row. A stored copy would be a second
-- version of the same fact, free to disagree with the first, and the one
-- that disagrees silently is the one that bills a client. (0016's comment
-- on mirrored columns, applied again.)
--
-- So: two columns on the new version, saying why it is higher. They are
-- null on a first quote and on any revision that stayed inside the
-- ceiling, which is how a screen can tell "no change order was needed"
-- from "one was, and here is the reason".
alter table quotes add column change_cause text;
alter table quotes add column change_reason text;
