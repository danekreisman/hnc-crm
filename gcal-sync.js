/* gcal-sync.js - wires appointment save/update/cancel to /api/google/sync-event */
(function(){
  function hncSyncGcal(id, action){
    if(!id) return;
    try {
      fetch('/api/google/sync-event', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ appointment_id: id, action: action || 'upsert' }) })
      .then(function(r){ if(!r.ok) console.warn('[HNC GCal] HTTP', r.status); })
      .catch(function(e){ console.warn('[HNC GCal] failed', e); });
    } catch(e) { console.warn('[HNC GCal] threw', e); }
  }
  window.hncSyncGcal = hncSyncGcal;
  function idFromRes(res, fallback){
    if (fallback) return fallback;
    if (!res) return null;
    if (res.data && res.data[0] && res.data[0].id) return res.data[0].id;
    if (Array.isArray(res) && res[0] && res[0].id) return res[0].id;
    if (res.id) return res.id;
    return null;
  }
  function wrap(name, action, idxOfDbId){
    var orig = window[name];
    if (typeof orig !== 'function') return false;
    window[name] = async function(){
      var args = arguments;
      var res = await orig.apply(this, args);
      try {
        var fallback = (idxOfDbId != null) ? args[idxOfDbId] : null;
        var id = idFromRes(res, fallback);
        hncSyncGcal(id, action);
      } catch(e){ console.warn('[HNC GCal] wrap', name, e); }
      return res;
    };
    return true;
  }
  function install(){
    wrap('dbSaveAppointment', 'upsert', null);
    wrap('dbUpdateAppointment', 'upsert', 0);
    var origCancel = window.cancelAppointment;
    if (typeof origCancel === 'function') {
      window.cancelAppointment = async function(){
        var before = window.currentAppt && window.currentAppt.db_id;
        var res = await origCancel.apply(this, arguments);
        try {
          var id = before || (window.currentAppt && window.currentAppt.db_id);
          if (id) hncSyncGcal(id, 'delete');
        } catch(e){ console.warn('[HNC GCal] cancel wrap', e); }
        return res;
      };
    }
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', install); } else { install(); }
})();
