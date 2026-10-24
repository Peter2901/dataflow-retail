#!/bin/bash
# Final regression: every test, old and new, fresh store and huge store. Writes final/summary.txt
S=$1
F=$S/final; rm -rf $F; mkdir -p $F
clean() { grep -v "agent-proxy\|connect_rejected\|Allowed domains\|For details\|^- \|^$"; }
log() { echo "$(date +%H:%M:%S) $*" >> $F/summary.txt; }
copyhuge() { rm -rf $1 && cp -r $S/engine/prof-huge-clean $1 && rm -f $1/Singleton*; }
cd $S
node build.mjs $S stress $S/site-stress > $F/build.log 2>&1 && node build.mjs $S production $S/site >> $F/build.log 2>&1
cp /home/claude/dataflow-retail/public/gst-rules.json site-stress/; cp /home/claude/dataflow-retail/public/gst-rules.json site/
log "build: $(tail -2 $F/build.log | tr '\n' ' ')"
for t in units gst gst2 search marg; do timeout 300 node $t.test.mjs > $F/unit-$t.log 2>&1; log "unit $t: exit $? $(tail -1 $F/unit-$t.log)"; done
timeout 900 node fuzz/run.mjs $S 2>&1 | clean > $F/fuzz.log; log "fuzz: $(tail -1 $F/fuzz.log) $(tail -2 $F/fuzz.log | head -1)"
timeout 1800 node engine/engine.mjs $S fresh 5221 1500 4 2 ffinal 2>&1 | clean > $F/engine-fresh.log; log "engine fresh: $(grep 'ENGINE CHECK' $F/engine-fresh.log) $(grep '^ran' $F/engine-fresh.log | cut -c1-200)"
copyhuge $S/final/prof-eh
timeout 3600 node engine/engine.mjs $S $S/final/prof-eh 5190 1500 4 2 hfinal 2>&1 | clean > $F/engine-huge.log; log "engine huge: $(grep 'ENGINE CHECK' $F/engine-huge.log) $(grep '^ran' $F/engine-huge.log | cut -c1-200)"
rm -rf $S/final/prof-eh
timeout 2400 node sync/volume.mjs $S 400 5222 54333 2>&1 | clean > $F/sync-volume.log; log "sync volume: $(grep 'SYNC VOLUME' $F/sync-volume.log) $(grep 'made' $F/sync-volume.log | cut -c1-90 | tr '\n' ' ')"
timeout 900 node stress/sync-test.mjs $S 2>&1 | clean > $F/sync-shopkey.log; log "sync shop key: $(grep 'SHOP KEY TEST' $F/sync-shopkey.log)"
timeout 1500 node stress/e2e-new.mjs $S 2>&1 | clean > $F/e2e-new.log; log "e2e-new: $(grep -c '^PASS' $F/e2e-new.log) pass, $(grep -c '^FAIL' $F/e2e-new.log) fail; $(grep 'page errors' $F/e2e-new.log)"
timeout 600 node e2e5.mjs $S 2>&1 | clean > $F/e2e5.log; log "e2e5 units/prices: $(grep -E 'WHOLE 1 Bag|ERRORS' $F/e2e5.log | tr '\n' ' ')"
for t in pages counter office; do
  rm -rf $F/prof-$t; timeout 2400 node ui/$t.mjs $S $F/prof-$t 523$((RANDOM % 9)) > $F/fresh-$t.log 2>&1; log "fresh $t: $(grep -E 'passed' $F/fresh-$t.log) $(grep '^FAIL' $F/fresh-$t.log | cut -c1-150 | tr '\n' ' ')"
  rm -rf $F/prof-$t
done
for t in office counter pages; do
  copyhuge $F/prof-h$t
  if [ $t = pages ]; then timeout 2400 node ui/pages.mjs $S $F/prof-h$t 5190 en > $F/huge-$t.log 2>&1; else timeout 2400 node ui/$t.mjs $S $F/prof-h$t 5190 > $F/huge-$t.log 2>&1; fi
  log "huge $t: $(grep -E 'passed' $F/huge-$t.log) $(grep '^FAIL' $F/huge-$t.log | cut -c1-150 | tr '\n' ' ')"
  rm -rf $F/prof-h$t
done
copyhuge $F/prof-time
timeout 1800 node ui/timing.mjs $S $F/prof-time 5190 2>&1 | clean > $F/timing.log; log "timing done"
rm -rf $F/prof-time
log "ALL DONE"
