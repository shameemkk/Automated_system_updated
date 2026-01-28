-- count
SELECT count(*)
FROM (
  SELECT
    id,
    status,
    ROW_NUMBER() OVER (
      PARTITION BY query
      ORDER BY
        -- Priority: Keep rows that represent real usage first
        (CASE WHEN status <> 'not_used' THEN 0 ELSE 1 END),
        -- Secondary Priority: Keep the oldest row
        id ASC
    ) as row_num
  FROM client_queries
  WHERE client_tag = '[freedomext]'
) sub
WHERE sub.row_num > 1      -- Only look at duplicates (2nd, 3rd copy etc)
AND sub.status = 'not_used'; -- STRICTLY ensuring we only delete 'not_used'


--delete 

create or replace function delete_freedomext_duplicates()
returns void
language plpgsql
as $$
begin
  with duplicates as (
    select
      id,
      row_number() over (
        partition by query
        order by
          -- Keep active/valid statuses first
          (case when status <> 'not_used' then 0 else 1 end),
          -- Keep oldest record
          id asc
      ) as row_num
    from
      client_queries
    where
      client_tag = '[freedomext]'
  )
  delete from client_queries
  where id in (
    select id
    from duplicates
    where row_num > 1
  )
  and status = 'not_used'; -- Final safety lock
end;
$$;


---use

SELECT delete_freedomext_duplicates();