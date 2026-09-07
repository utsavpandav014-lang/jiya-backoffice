-- pg_cron schedules are UTC. 13:30 UTC is 19:00 Asia/Kolkata (IST).
do $$
begin
  if exists(select 1 from cron.job where jobname='jiya-daily-interest') then
    perform cron.unschedule('jiya-daily-interest');
  end if;
  perform cron.schedule(
    'jiya-daily-interest',
    '30 13 * * *',
    'select private.apply_daily_interest();'
  );
end $$;
