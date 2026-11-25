(function(){
  "use strict";

  var CFG = window.FRIMOR_CONFIG || {};
  var CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('xxxx') === -1
                 && CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf('colle-ici') === -1;
  var ONESIGNAL_CONFIGURED = CFG.ONESIGNAL_APP_ID && CFG.ONESIGNAL_APP_ID.indexOf('colle-ici') === -1;

  // Mode "annexe tablette" : activé par tablette.html (window.FRIMOR_TABLET_MODE = true
  // avant le chargement de ce fichier). Sur ce mode, tout le monde (y compris les
  // administrateurs) n'a que les onglets Tâches + Suivi, et l'onglet Suivi affiche
  // le tableau de bord "qui a fait quoi aujourd'hui" (habituellement réservé à Gestion)
  // au lieu du suivi d'habitudes personnel. Reste strictement false sur index.html.
  var TABLET_MODE = !!window.FRIMOR_TABLET_MODE;

  var sb = null;
  if (CONFIGURED && window.supabase){
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }

  var session = null;        // {id, name, is_admin}
  var employees = {};        // id -> {id,name,is_admin}
  var assignees = {};        // taskId -> Set(employeeId), pour les tâches obligatoires
  var loginSelectedId = null;
  var viewAsId = null;       // id de l'employé consulté par le patron (lecture seule), ou null = vue de soi-même

  // Sur la tablette (partagée entre tout le monde dans l'entrepôt), on déconnecte
  // automatiquement le profil 5 minutes après la connexion, pour ne jamais
  // laisser le profil de quelqu'un ouvert pour la personne suivante. N'a
  // aucun effet sur l'appli téléphone/ordinateur (TABLET_MODE y est faux).
  var TABLET_AUTO_LOGOUT_MS = 5 * 60 * 1000;
  var tabletLogoutTimer = null;
  function scheduleTabletAutoLogout(){
    if (!TABLET_MODE) return;
    clearTimeout(tabletLogoutTimer);
    tabletLogoutTimer = setTimeout(function(){
      clearSession();
      location.reload();
    }, TABLET_AUTO_LOGOUT_MS);
  }

  function viewingEmployeeId(){ return viewAsId || (session && session.id); }
  function isReadOnlyView(){ return !!viewAsId; }

  var tasks = {};   // id -> {id,title,time,createdAt,example,recurrence:{type,days},ownerEmployeeId,isMandatory}
  var logs = {};    // "date_taskId_employeeId" -> {date,taskId,done,note,blocked}
  var todayLogsAll = {}; // pour le tableau de bord patron : "date_taskId_employeeId" -> done, pour TOUS les employés, jour courant
  var dashExpanded = {}; // id employé -> true si sa ligne est "dépliée" dans le tableau de bord (Suivi / Gestion)
  var dueSoon = new Set();
  var overdue = new Set();
  var notifiedKeys = new Set();

  // Changements (coché / note / empêchement) pas encore envoyés au serveur,
  // typiquement parce que la connexion a coupé (ex. chambre froide). On les
  // garde ici ET dans localStorage, pour les ré-essayer automatiquement dès
  // que la connexion revient — sans jamais perdre l'action de l'employé.
  // Clé = "date_taskId_employeeId" (même clé que logs), valeur = l'opération
  // à rejouer : { kind:'upsert', payload } ou { kind:'delete' }.
  function loadPendingSync(){ try{ var raw = localStorage.getItem('frimor_pending_sync'); return raw ? JSON.parse(raw) : {}; }catch(e){ return {}; } }
  function savePendingSync(){ try{ localStorage.setItem('frimor_pending_sync', JSON.stringify(pendingSync)); }catch(e){} }
  var pendingSync = loadPendingSync();
  var flushingSync = false;
  var flushSoonTimer = null;

  var DAY_NAMES = {0:'DIM',1:'LUN',2:'MAR',3:'MER',4:'JEU',5:'VEN',6:'SAM'};
  var REMINDER_LEAD_MIN = 20;
  var FREQ_DATE_HINTS = {
    date: "Cette tâche n'aura lieu qu'à cette date, une seule fois.",
    monthly: "Cette tâche reviendra chaque mois, le même jour du mois.",
    quarterly: "Cette tâche reviendra tous les 3 mois, le même jour du mois.",
    annual: "Cette tâche reviendra chaque année, à la même date."
  };

  var EXAMPLE_TASKS = [
    {title:"Relevé des températures chambres froides", time:"08:00", recurrence_type:'daily', recurrence_days:[]},
    {title:"Contrôle entrées/sorties de stock", time:"10:30", recurrence_type:'daily', recurrence_days:[]},
    {title:"Vérification des chariots frigo", time:"14:00", recurrence_type:'days', recurrence_days:[1,2,3,4,5]},
    {title:"Fermeture entrepôt — relevé final", time:"18:00", recurrence_type:'daily', recurrence_days:[]}
  ];

  function pad(n){ return String(n).padStart(2,"0"); }
  function dateKey(d){ d = d || new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
  function dateFromKey(ds){ var p = ds.split("-"); return new Date(+p[0], +p[1]-1, +p[2]); }
  function addDays(d, n){ var c = new Date(d); c.setDate(c.getDate()+n); return c; }
  function taskDateTime(task, ds){
    var hm = task.time.split(":"); var ymd = ds.split("-");
    return new Date(+ymd[0], +ymd[1]-1, +ymd[2], +hm[0], +hm[1], 0, 0);
  }
  function fmtDayLabel(d){ return d.toLocaleDateString('fr-FR',{weekday:'narrow'}).toUpperCase(); }
  function fmtDateShort(ds){ var d = dateFromKey(ds); return pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear(); }
  function fmtDateShortNoYear(ds){ var d = dateFromKey(ds); return pad(d.getDate())+'/'+pad(d.getMonth()+1); }
  function dayOfMonthLabel(ds){ return dateFromKey(ds).getDate(); }
  function daysInMonth(y, m){ return new Date(y, m+1, 0).getDate(); } // m : 0-indexé
  // Vérifie si `d` tombe sur le même jour-du-mois que `anchor`, tous les
  // `everyNMonths` mois à partir de `anchor` (mensuel=1, trimestriel=3,
  // annuel=12). Si le mois de `d` a moins de jours que le jour d'ancrage
  // (ex. ancrage le 31, mois de 30 jours), on retombe sur le dernier jour du
  // mois — pour ne jamais "sauter" un mois silencieusement.
  function matchesPeriodic(anchor, d, everyNMonths){
    var a0 = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    var d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (d0 < a0) return false;
    var diffMonths = (d0.getFullYear()-a0.getFullYear())*12 + (d0.getMonth()-a0.getMonth());
    if (diffMonths < 0 || diffMonths % everyNMonths !== 0) return false;
    var lastDay = daysInMonth(d0.getFullYear(), d0.getMonth());
    var targetDay = Math.min(a0.getDate(), lastDay);
    return d0.getDate() === targetDay;
  }
  function isScheduled(task, date){
    var rec = task.recurrence || {type:'daily'};
    if (rec.type === 'days') return (rec.days || []).indexOf(date.getDay()) !== -1;
    if (rec.type === 'date') return !!rec.date && dateKey(date) === rec.date;
    if (rec.type === 'monthly') return !!rec.date && matchesPeriodic(dateFromKey(rec.date), date, 1);
    if (rec.type === 'quarterly') return !!rec.date && matchesPeriodic(dateFromKey(rec.date), date, 3);
    if (rec.type === 'annual') return !!rec.date && matchesPeriodic(dateFromKey(rec.date), date, 12);
    return true; // daily
  }
  function freqLabel(task){
    var rec = task.recurrence;
    if (!rec) return '';
    if (rec.type === 'days') return (rec.days || []).slice().sort().map(function(d){ return DAY_NAMES[d]; }).join('·');
    if (rec.type === 'date') return rec.date ? fmtDateShort(rec.date) : '';
    if (rec.type === 'monthly') return rec.date ? ('tous les mois · le '+dayOfMonthLabel(rec.date)) : '';
    if (rec.type === 'quarterly') return rec.date ? ('tous les 3 mois · le '+dayOfMonthLabel(rec.date)) : '';
    if (rec.type === 'annual') return rec.date ? ('chaque année · '+fmtDateShortNoYear(rec.date)) : '';
    return '';
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function logKey(taskId, ds){ return ds + "_" + taskId + "_" + (viewingEmployeeId() || ''); }

  function toast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  }

  var actx = null;
  function beep(){
    try{
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, actx.currentTime+0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime+0.35);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime+0.36);
    }catch(e){}
  }

  // ======================= session / login =======================

  function saveSession(s){ try{ localStorage.setItem('frimor_session', JSON.stringify(s)); }catch(e){} }
  function getSavedSession(){ try{ var raw = localStorage.getItem('frimor_session'); return raw ? JSON.parse(raw) : null; }catch(e){ return null; } }
  function clearSession(){ try{ localStorage.removeItem('frimor_session'); }catch(e){} }

  function renderLoginNames(){
    var box = document.getElementById('login-names');
    var list = Object.values(employees).sort(function(a,b){ return a.name.localeCompare(b.name,'fr'); });
    box.innerHTML = list.length
      ? list.map(function(e){ return '<button type="button" class="login-name-btn" data-id="'+e.id+'">'+escapeHtml(e.name)+'</button>'; }).join('')
      : '<div class="empty-state">Aucun compte pour l\'instant.</div>';
  }

  document.getElementById('login-names').addEventListener('click', function(e){
    var btn = e.target.closest('.login-name-btn');
    if (!btn) return;
    loginSelectedId = btn.dataset.id;
    var emp = employees[loginSelectedId];
    document.getElementById('login-pin-name').textContent = emp ? emp.name : '';
    document.getElementById('login-names-step').hidden = true;
    document.getElementById('login-pin-step').hidden = false;
    document.getElementById('login-error').hidden = true;
    var input = document.getElementById('login-pin-input');
    input.value = '';
    setTimeout(function(){ input.focus(); }, 150);
  });

  document.getElementById('login-back').addEventListener('click', function(){
    document.getElementById('login-pin-step').hidden = true;
    document.getElementById('login-names-step').hidden = false;
    document.getElementById('login-pin-input').value = '';
  });

  document.getElementById('login-pin-input').addEventListener('input', function(){
    var v = this.value.replace(/\D/g,'').slice(0,4);
    this.value = v;
    document.getElementById('login-error').hidden = true;
    if (v.length === 4){ attemptLogin(loginSelectedId, v); }
  });

  function attemptLogin(id, pin){
    if (!sb || !id) return;
    sb.from('employees').select('id,name,is_admin,pin').eq('id', id).single().then(function(res){
      if (res.error || !res.data || String(res.data.pin) !== pin){
        document.getElementById('login-error').hidden = false;
        document.getElementById('login-pin-input').value = '';
        return;
      }
      session = { id: res.data.id, name: res.data.name, is_admin: !!res.data.is_admin };
      enterApp();
    }).catch(function(){
      document.getElementById('login-error').hidden = false;
    });
  }

  document.getElementById('user-chip').addEventListener('click', function(){
    openSheetAccount();
  });

  function enterApp(){
    document.getElementById('login-screen').hidden = true;
    document.getElementById('user-chip').hidden = false;
    document.getElementById('user-chip-name').textContent = session.name;
    var tabAdminEl = document.getElementById('tab-admin');
    if (tabAdminEl) tabAdminEl.hidden = TABLET_MODE || !session.is_admin;
    saveSession(session);
    syncPlayerIdSoon();
    updateSyncBadge();
    flushPendingSync();
    scheduleTabletAutoLogout();

    loadAssignees().then(function(){
      return Promise.all([loadTasks(), loadLogs()]);
    }).then(function(){
      splashTasksLoaded = true; splashLogsLoaded = true; splashMarkReady();
    }).catch(function(){ splashMarkReady(); });

    wireRealtime();
    if (TABLET_MODE) loadDashboardLogs();
    setInterval(function(){ renderHeaderDate(); checkReminders(); flushPendingSync(); }, 20000);
    setInterval(function(){
      renderTracker(); renderPlanning();
      if (session && (session.is_admin || TABLET_MODE)) loadDashboardLogs();
    }, 60000);
  }

  // ======================= rendering =======================

  function renderHeaderDate(){
    var el = document.getElementById('today-date');
    var now = new Date();
    var day = now.toLocaleDateString('fr-FR',{weekday:'short'});
    el.textContent = day.replace('.','') + "\n" + pad(now.getDate())+"/"+pad(now.getMonth()+1);
  }

  function allTaskList(){
    if (!session) return [];
    var eid = viewingEmployeeId();
    return Object.values(tasks).filter(function(t){
      if (t.isMandatory) return assignees[t.id] && assignees[t.id].has(eid);
      return t.ownerEmployeeId === eid;
    }).sort(function(a,b){ return a.time.localeCompare(b.time); });
  }
  function todayTaskList(){
    var today = new Date();
    return allTaskList().filter(function(t){ return isScheduled(t, today); });
  }

  // comme allTaskList(), mais pour un employé précis (pas forcément celui
  // de la session) — utilisé par le tableau de bord du patron.
  function employeeTasksFor(employeeId){
    return Object.values(tasks).filter(function(t){
      if (t.isMandatory) return assignees[t.id] && assignees[t.id].has(employeeId);
      return t.ownerEmployeeId === employeeId;
    }).sort(function(a,b){ return a.time.localeCompare(b.time); });
  }

  function renderRail(){
    var rail = document.getElementById('rail');
    var list = todayTaskList();
    var chips = [];
    list.forEach(function(t){
      if (dueSoon.has(t.id)){
        var dt = taskDateTime(t, dateKey());
        var mins = Math.max(0, Math.round((dt - new Date())/60000));
        chips.push('<div class="rail-chip"><span class="dot"></span>'+escapeHtml(t.title)+' · dans '+mins+' min</div>');
      } else if (overdue.has(t.id)){
        chips.push('<div class="rail-chip overdue"><span class="dot"></span>'+escapeHtml(t.title)+' · en retard</div>');
      }
    });
    rail.innerHTML = chips.join('');
    rail.hidden = chips.length === 0;
  }

  var pendingDelete = null;

  function taskRowHtml(t, ds, ro){
    var key = logKey(t.id, ds);
    var log = logs[key];
    var done = !!(log && log.done);
    var blocked = !!(log && log.blocked);
    var note = (log && log.note) || '';
    var cls = 'task-row';
    if (done) cls += ' done';
    else if (blocked) cls += ' blocked';
    else if (dueSoon.has(t.id)) cls += ' due';
    else if (overdue.has(t.id)) cls += ' overdue';

    var delIsConfirm = pendingDelete === t.id;

    var html = '<div class="'+cls+'" data-id="'+t.id+'">'
      + '<button class="check"'+(ro ? '' : ' data-action="toggle"')+'>'
        + '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</button>'
      + '<div class="task-main">'
        + '<span class="task-title">'+escapeHtml(t.title)+'</span>'
        + '<span class="task-meta">'
          + (blocked ? '<span class="tag tag-alert">empêchement signalé</span>' : '')
          + (overdue.has(t.id) && !done && !blocked ? '<span class="tag tag-alert">en retard</span>' : '')
          + (freqLabel(t) ? '<span class="tag">'+freqLabel(t)+'</span>' : '')
          + (t.example ? '<span class="tag">exemple</span>' : '')
        + '</span>'
        + (note ? '<span class="task-note-text">'+escapeHtml(note)+'</span>' : '')
      + '</div>'
      + '<span class="task-time mono">'+t.time+'</span>'
      + (ro ? '' : '<button class="task-note'+((note||blocked)?' has-note':'')+'" data-action="note" aria-label="Note / signaler un empêchement">'
        + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
        + '</button>')
      + (t.isMandatory || ro ? '' : '<button class="task-edit" data-action="edit" aria-label="Modifier la tâche">'
        + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>'
        + '</button>')
      + (t.isMandatory || ro ? '' : '<button class="task-del'+(delIsConfirm?' confirm':'')+'" data-action="delete">'
        + (delIsConfirm ? 'SUPPR.' : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/></svg>')
        + '</button>')
      + '</div>';
    return { html: html, done: done };
  }

  function updateAppBadge(pendingCount){
    try{
      if (pendingCount > 0 && 'setAppBadge' in navigator) navigator.setAppBadge(pendingCount).catch(function(){});
      else if (pendingCount === 0 && 'clearAppBadge' in navigator) navigator.clearAppBadge().catch(function(){});
    }catch(e){}
  }

  function renderTasks(){
    var list = todayTaskList();
    var ds = dateKey();
    var container = document.getElementById('task-list');
    var ro = isReadOnlyView();

    if (list.length === 0){
      var hasAnyTask = allTaskList().length > 0;
      container.innerHTML = ro
        ? '<div class="empty-state">Aucune tâche prévue aujourd\'hui pour ce profil.</div>'
        : (hasAnyTask
          ? '<div class="empty-state">Aucune tâche prévue aujourd\'hui.<br>Regarde l\'onglet Planning pour voir la semaine.</div>'
          : '<div class="empty-state">Aucune tâche aujourd\'hui.<br>Ajoute ta première tâche avec le bouton +.</div>');
      document.getElementById('today-count').textContent = '0/0';
      var bar0 = document.getElementById('today-progress');
      if (bar0) bar0.style.width = '0%';
      if (!ro) updateAppBadge(0);
      return;
    }

    var mandatoryList = list.filter(function(t){ return t.isMandatory; });
    var personalList = list.filter(function(t){ return !t.isMandatory; });
    var doneCount = 0;

    function group(label, items){
      if (items.length === 0) return '';
      var groupDone = 0;
      var rows = items.map(function(t){
        var r = taskRowHtml(t, ds, ro);
        if (r.done){ groupDone++; doneCount++; }
        return r.html;
      }).join('');
      return '<div class="task-group-label">'+label+' <span class="count">'+groupDone+'/'+items.length+'</span></div>'
        + '<div class="task-group">' + rows + '</div>';
    }

    container.innerHTML = group('Obligatoire', mandatoryList) + group('Tes tâches', personalList);

    document.getElementById('today-count').textContent = doneCount + '/' + list.length;
    var pct = list.length ? Math.round(100 * doneCount / list.length) : 0;
    var bar = document.getElementById('today-progress');
    if (bar) bar.style.width = pct + '%';
    if (!ro) updateAppBadge(list.length - doneCount);
  }

  function scheduledOn(t, ds){
    return t.createdAt.slice(0,10) <= ds && isScheduled(t, dateFromKey(ds));
  }
  function dayFullyDone(ds, list){
    var active = list.filter(function(t){ return scheduledOn(t, ds); });
    if (active.length === 0) return false;
    return active.every(function(t){ var l = logs[logKey(t.id, ds)]; return l && l.done; });
  }

  function renderTracker(){
    var list = allTaskList();
    var tracker = document.getElementById('tracker');
    var axis = document.getElementById('tracker-axis');
    var today = new Date();
    var days = [];
    for (var i = 13; i >= 0; i--) days.push(addDays(today, -i));

    if (list.length === 0){
      tracker.innerHTML = '<div class="empty-state">Ton suivi d\'habitudes apparaîtra ici dès que tu auras ajouté des tâches.</div>';
      axis.innerHTML = '';
    } else {
      tracker.innerHTML = list.map(function(t){
        var cells = days.map(function(d){
          var ds = dateKey(d);
          var cls = 'cell';
          if (!scheduledOn(t, ds)){ cls += ' na'; }
          else {
            var log = logs[logKey(t.id, ds)];
            var done = log && log.done;
            if (done) cls += ' done';
            else if (ds === dateKey(today)) cls += ' today-pending';
            else cls += ' missed';
          }
          return '<div class="'+cls+'" title="'+ds+'"></div>';
        }).join('');
        return '<div class="tracker-row"><div class="tracker-name">'+escapeHtml(t.title)+'</div><div class="tracker-cells">'+cells+'</div></div>';
      }).join('');
      axis.innerHTML = days.map(function(d,i){
        return (i % 2 === 0) ? '<span>'+fmtDayLabel(d)+'</span>' : '<span></span>';
      }).join('');
    }

    var streak = 0;
    var cursor = new Date(today);
    if (!dayFullyDone(dateKey(cursor), list)) cursor = addDays(cursor, -1);
    while (dayFullyDone(dateKey(cursor), list)){ streak++; cursor = addDays(cursor, -1); }
    document.getElementById('stat-streak').textContent = streak;

    var ds = dateKey(today);
    var activeToday = list.filter(function(t){ return scheduledOn(t, ds); });
    var doneToday = activeToday.filter(function(t){ var l = logs[logKey(t.id, ds)]; return l && l.done; }).length;
    var pct = activeToday.length ? Math.round(100*doneToday/activeToday.length) : 0;
    document.getElementById('stat-today').textContent = pct + '%';
  }

  function fmtGroupLabel(d, isToday){
    if (isToday) return "Aujourd'hui";
    var wd = d.toLocaleDateString('fr-FR',{weekday:'long'});
    wd = wd.charAt(0).toUpperCase() + wd.slice(1);
    return wd + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth()+1);
  }

  function renderPlanning(){
    var container = document.getElementById('planning-list');
    var list = allTaskList();
    var today = new Date();
    var html = '';
    var any = false;
    var ro = isReadOnlyView();

    for (var i = 0; i < 14; i++){
      var d = addDays(today, i);
      var ds = dateKey(d);
      var dayTasks = list.filter(function(t){ return scheduledOn(t, ds); });
      if (dayTasks.length === 0) continue;
      any = true;
      var rows = dayTasks.map(function(t){
        var freq = freqLabel(t);
        return '<div class="plan-row">'
          + '<span class="plan-time mono">'+t.time+'</span>'
          + '<span class="plan-title">'+escapeHtml(t.title)+'</span>'
          + (freq ? '<span class="tag">'+freq+'</span>' : '')
          + (t.isMandatory ? '<span class="tag">obligatoire</span>' : '')
          + '</div>';
      }).join('');
      var addRow = ro ? '' : '<button type="button" class="plan-add" data-day="'+d.getDay()+'">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>'
        + 'Ajouter une tâche ce jour</button>';
      html += '<div class="day-group">'
        + '<div class="day-group-header'+(i===0?' today':'')+'">'+fmtGroupLabel(d, i===0)+'<span class="n">· '+dayTasks.length+' tâche'+(dayTasks.length>1?'s':'')+'</span></div>'
        + '<div class="day-card">'+rows+addRow+'</div>'
        + '</div>';
    }

    container.innerHTML = any ? html : '<div class="empty-state">Aucune tâche planifiée pour les 14 prochains jours.<br>Ajoute-en depuis l\'onglet Tâches.</div>';
  }

  function renderAll(){
    renderHeaderDate();
    renderRail();
    renderTasks();
    renderTracker();
    renderPlanning();
  }

  // ======================= reminders (pendant que l'appli est ouverte) =======================

  function checkReminders(){
    if (isReadOnlyView()) return;
    var now = new Date();
    var ds = dateKey(now);
    var changed = false;
    todayTaskList().forEach(function(t){
      var key = logKey(t.id, ds);
      var log = logs[key];
      var done = !!(log && log.done);
      if (done){
        if (dueSoon.delete(t.id)) changed = true;
        if (overdue.delete(t.id)) changed = true;
        return;
      }
      var dt = taskDateTime(t, ds);
      var diffMin = (dt - now) / 60000;
      if (diffMin <= REMINDER_LEAD_MIN && diffMin >= 0){
        if (!dueSoon.has(t.id)) changed = true;
        dueSoon.add(t.id); overdue.delete(t.id);
        if (!notifiedKeys.has(key)){
          notifiedKeys.add(key);
          toast((Math.round(diffMin) <= 0 ? 'À faire maintenant : ' : 'Dans '+Math.round(diffMin)+' min : ') + t.title);
          beep();
        }
      } else if (diffMin < 0){
        // Reste "en retard" (affichage en rouge) indéfiniment tant que la
        // tâche n'est pas faite — pas de limite de temps : c'est voulu, pour
        // que personne ne puisse "oublier" une tâche non faite.
        if (!overdue.has(t.id)) changed = true;
        overdue.add(t.id); dueSoon.delete(t.id);
      } else {
        if (dueSoon.delete(t.id)) changed = true;
        if (overdue.delete(t.id)) changed = true;
      }
    });
    if (changed){ renderRail(); renderTasks(); }
  }

  // ======================= notifications OneSignal (écran verrouillé) =======================

  function refreshNotifBanner(){
    var banner = document.getElementById('notif-banner');
    if (!ONESIGNAL_CONFIGURED){ banner.hidden = true; return; }
    try{
      var OS = window.OneSignal;
      var granted = !!(OS && OS.Notifications && OS.Notifications.permission);
      banner.hidden = granted;
    }catch(e){ banner.hidden = false; }
  }

  function currentOneSignalId(){
    try{
      if (window.OneSignal && window.OneSignal.User && window.OneSignal.User.PushSubscription){
        return window.OneSignal.User.PushSubscription.id || null;
      }
    }catch(e){}
    return null;
  }

  function syncPlayerIdToEmployee(){
    if (!sb || !session) return;
    var pid = currentOneSignalId();
    if (!pid) return;
    // Un même téléphone/navigateur (donc un même identifiant OneSignal) ne doit
    // jamais être enregistré que chez UN SEUL employé à la fois : sinon, si
    // plusieurs personnes se sont connectées tour à tour sur cet appareil, il
    // continue de recevoir les notifications de tout le monde. On le retire
    // d'abord de tous les autres employés avant de l'ajouter ici.
    sb.from('employees').select('id,player_ids').then(function(res){
      if (res.error || !res.data) return;
      res.data.forEach(function(row){
        var ids = row.player_ids || [];
        if (row.id === session.id){
          if (ids.indexOf(pid) === -1){
            sb.from('employees').update({ player_ids: ids.concat([pid]) }).eq('id', row.id).then(function(){});
          }
        } else if (ids.indexOf(pid) !== -1){
          sb.from('employees').update({ player_ids: ids.filter(function(x){ return x !== pid; }) }).eq('id', row.id).then(function(){});
        }
      });
    }).catch(function(){});
  }
  function syncPlayerIdSoon(){ setTimeout(syncPlayerIdToEmployee, 1500); }

  document.getElementById('notif-enable').addEventListener('click', function(){
    if (!ONESIGNAL_CONFIGURED){ toast('OneSignal n\'est pas encore configuré (config.js).'); return; }
    try{
      var OS = window.OneSignal;
      if (OS && OS.Notifications && typeof OS.Notifications.requestPermission === 'function'){
        OS.Notifications.requestPermission().then(function(){
          toast('Rappels activés sur ce téléphone.');
          refreshNotifBanner();
          syncPlayerIdSoon();
        }).catch(function(){ toast('Active les notifications dans les réglages de ton téléphone.'); });
      } else {
        toast('Encore en cours de chargement, réessaie dans quelques secondes.');
      }
    }catch(e){ toast('Impossible d\'activer les rappels pour le moment.'); }
  });

  if (ONESIGNAL_CONFIGURED){
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(function(OneSignal){
      window.OneSignal = OneSignal;
      OneSignal.init({ appId: CFG.ONESIGNAL_APP_ID }).then(function(){
        refreshNotifBanner();
        syncPlayerIdSoon();
        try{
          OneSignal.Notifications.addEventListener('permissionChange', function(){
            refreshNotifBanner();
            syncPlayerIdSoon();
          });
        }catch(e){}
      }).catch(function(){});
    });
  }

  // Bouton manuel : reprogramme tout de suite les notifications des tâches
  // (utile après avoir ajouté une tâche pour aujourd'hui, sans attendre le
  // passage automatique du soir).
  document.getElementById('sync-notifs').addEventListener('click', function(){
    var btn = this;
    if (btn.classList.contains('is-syncing')) return;
    btn.classList.add('is-syncing');
    fetch('/api/sync-notifications').then(function(r){ return r.json(); }).then(function(data){
      btn.classList.remove('is-syncing');
      if (!data || data.error){ toast('Synchro impossible pour le moment.'); return; }
      if (data.scheduled > 0){
        toast(data.scheduled + ' notification' + (data.scheduled > 1 ? 's' : '') + ' programmée' + (data.scheduled > 1 ? 's' : '') + '.');
      } else {
        toast('Déjà à jour.');
      }
    }).catch(function(){
      btn.classList.remove('is-syncing');
      toast('Synchro impossible pour le moment.');
    });
  });

  // ======================= dictée vocale (ajout de tâche) =======================
  // Permet de remplir le nom d'une tâche en parlant au lieu de taper, grâce à la
  // reconnaissance vocale du navigateur (en français). Le bouton se trouve à
  // côté du champ "Nom de la tâche" dans la fiche d'ajout (bouton +). Si
  // l'appareil ne supporte pas cette fonction, le bouton micro est simplement
  // caché — le reste du formulaire continue de fonctionner normalement au clavier.
  var SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micRecognition = null;
  var micListening = false;

  function stopMic(){
    micListening = false;
    var btn = document.getElementById('f-title-mic');
    if (btn) btn.classList.remove('listening');
    if (micRecognition){ try{ micRecognition.stop(); }catch(e){} }
  }

  function startMic(){
    if (!SpeechRecognitionImpl) return;
    if (micListening){ stopMic(); return; }
    micRecognition = new SpeechRecognitionImpl();
    micRecognition.lang = 'fr-FR';
    micRecognition.continuous = false;
    micRecognition.interimResults = false;
    micRecognition.maxAlternatives = 1;
    micListening = true;
    var btn = document.getElementById('f-title-mic');
    if (btn) btn.classList.add('listening');
    toast('Je t\'écoute…');
    micRecognition.onresult = function(e){
      var transcript = (e.results && e.results[0] && e.results[0][0]) ? e.results[0][0].transcript : '';
      transcript = transcript.trim();
      if (transcript){
        transcript = transcript.charAt(0).toUpperCase() + transcript.slice(1);
        var titleInput = document.getElementById('f-title');
        if (titleInput) titleInput.value = transcript.slice(0, 60);
        toast('Texte ajouté : vérifie et appuie sur Ajouter.');
      }
    };
    micRecognition.onerror = function(){ toast('La dictée n\'a pas fonctionné, réessaie.'); };
    micRecognition.onend = function(){ stopMic(); };
    try{ micRecognition.start(); }catch(e){ stopMic(); }
  }

  (function wireMicButton(){
    var micBtnEl = document.getElementById('f-title-mic');
    if (!micBtnEl) return;
    if (!SpeechRecognitionImpl){ micBtnEl.hidden = true; return; }
    micBtnEl.addEventListener('click', startMic);
  })();

  // ======================= Supabase : chargement + écriture =======================

  function rowToTask(row){
    return {
      id: row.id,
      title: row.title,
      time: row.time,
      createdAt: row.created_at,
      example: !!row.example,
      recurrence: { type: row.recurrence_type || 'daily', days: row.recurrence_days || [], date: row.recurrence_date || null },
      ownerEmployeeId: row.owner_employee_id || null,
      isMandatory: !!row.is_mandatory
    };
  }
  var DATED_RECURRENCE_TYPES = ['date','monthly','quarterly','annual'];
  function recurrenceToRow(recurrence){
    return {
      recurrence_type: recurrence.type,
      recurrence_days: recurrence.type === 'days' ? recurrence.days : [],
      recurrence_date: DATED_RECURRENCE_TYPES.indexOf(recurrence.type) !== -1 ? recurrence.date : null
    };
  }

  var splashTasksLoaded = false, splashLogsLoaded = false, splashReady = false, splashProgress = 0, splashTimer = null;
  function splashMarkReady(){ splashReady = true; }
  function splashTick(){
    if (!splashReady){
      var target = 92;
      splashProgress += (target - splashProgress) * 0.05 + 0.25;
      if (splashProgress > target) splashProgress = target;
    } else { splashProgress += 7; }
    var p = Math.min(100, Math.round(splashProgress));
    var bar = document.getElementById('splash-bar');
    var pct = document.getElementById('splash-pct');
    if (bar) bar.style.width = p + '%';
    if (pct) pct.textContent = p + '%';
    if (splashProgress >= 100){ clearInterval(splashTimer); splashFinish(); }
  }
  function splashFinish(){
    var el = document.getElementById('splash');
    if (!el) return;
    setTimeout(function(){
      el.classList.add('hide');
      setTimeout(function(){ el.remove(); }, 500);
    }, 150);
  }

  function loadEmployees(){
    if (!sb) return Promise.resolve();
    return sb.from('employees').select('id,name,is_admin,replaced_by').then(function(res){
      if (res.error) return;
      var next = {};
      (res.data || []).forEach(function(row){
        next[row.id] = { id: row.id, name: row.name, is_admin: !!row.is_admin, replacedBy: row.replaced_by || null };
      });
      employees = next;
      if (session && session.is_admin){ renderAdminEmployees(); }
      if (!session){ renderLoginNames(); }
    });
  }

  function loadAssignees(){
    if (!sb) return Promise.resolve();
    return sb.from('task_assignees').select('task_id,employee_id').then(function(res){
      if (res.error) return;
      var next = {};
      (res.data || []).forEach(function(row){
        if (!next[row.task_id]) next[row.task_id] = new Set();
        next[row.task_id].add(row.employee_id);
      });
      assignees = next;
      renderAll();
      if (session && session.is_admin){ renderAdminTasks(); }
    });
  }

  async function loadTasks(){
    if (!sb) return;
    var res = await sb.from('tasks').select('*');
    if (res.error){ toast('Erreur de chargement des tâches.'); return; }
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = rowToTask(row); });
    tasks = next;
    renderAll();
    if (session && session.is_admin){ renderAdminTasks(); }
  }

  async function loadLogsFor(employeeId){
    if (!sb || !employeeId) return;
    var cutoff = dateKey(addDays(new Date(), -13));
    var res = await sb.from('logs').select('*').eq('employee_id', employeeId).gte('date', cutoff);
    if (res.error){ toast('Erreur de chargement du suivi.'); return; }
    // Si la vue a changé pendant le chargement (ex. le patron a déjà quitté
    // ou changé d'employé consulté), on ignore ce résultat devenu obsolète.
    if (employeeId !== viewingEmployeeId()) return;
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = { date: row.date, taskId: row.task_id, done: !!row.done, note: row.note || '', blocked: !!row.blocked }; });
    // Réapplique par-dessus les changements pas encore synchronisés (hors
    // connexion), sinon une case cochée sans réseau réapparaîtrait "pas
    // faite" à l'écran dès qu'on recharge le suivi depuis le serveur.
    Object.keys(pendingSync).forEach(function(key){
      var op = pendingSync[key];
      if (!op) return;
      if (op.kind === 'upsert'){
        next[key] = { date: op.payload.date, taskId: op.payload.task_id, done: !!op.payload.done, note: op.payload.note || '', blocked: !!op.payload.blocked };
      } else if (op.kind === 'delete'){
        delete next[key];
      }
    });
    logs = next;
    renderAll();
    checkReminders();
  }
  function loadLogs(){ return loadLogsFor(session ? session.id : null); }

  // ======================= synchronisation hors-ligne =======================

  function updateSyncBadge(){
    var banner = document.getElementById('pending-sync-banner');
    if (!banner) return;
    var n = Object.keys(pendingSync).length;
    if (n === 0){ banner.hidden = true; return; }
    banner.hidden = false;
    document.getElementById('pending-sync-text').textContent =
      n + (n > 1 ? ' actions' : ' action') + ' pas encore enregistrée' + (n > 1 ? 's' : '') + ' en ligne (pas de réseau) — seront envoyées automatiquement dès que la connexion revient.';
  }

  function queuePending(key, op){
    pendingSync[key] = op;
    savePendingSync();
    updateSyncBadge();
    clearTimeout(flushSoonTimer);
    flushSoonTimer = setTimeout(flushPendingSync, 4000);
  }
  function clearPending(key){
    if (pendingSync[key]){ delete pendingSync[key]; savePendingSync(); updateSyncBadge(); }
  }

  // Rejoue les changements en attente. Silencieux en cas d'échec (on
  // retentera plus tard) ; un petit toast confirme seulement quand tout est
  // enfin synchronisé, pour que l'employé sache que c'est bon.
  async function flushPendingSync(){
    if (!sb || flushingSync) return;
    if (navigator.onLine === false) return;
    var keys = Object.keys(pendingSync);
    if (keys.length === 0) return;
    flushingSync = true;
    var clearedAny = false;
    for (var i = 0; i < keys.length; i++){
      var key = keys[i];
      var op = pendingSync[key];
      if (!op) continue;
      try{
        var res = (op.kind === 'delete')
          ? await sb.from('logs').delete().eq('id', key)
          : await sb.from('logs').upsert(op.payload);
        if (!res.error){ delete pendingSync[key]; clearedAny = true; }
      }catch(e){ /* toujours hors-ligne, on retentera plus tard */ }
    }
    if (clearedAny){
      savePendingSync();
      updateSyncBadge();
      if (Object.keys(pendingSync).length === 0) toast('Synchronisé.');
    }
    flushingSync = false;
  }

  window.addEventListener('online', flushPendingSync);
  document.addEventListener('visibilitychange', function(){ if (document.visibilityState === 'visible') flushPendingSync(); });
  document.getElementById('pending-sync-retry').addEventListener('click', flushPendingSync);

  // Pour le tableau de bord du patron : l'état fait/pas fait/empêchement d'AUJOURD'HUI,
  // pour tous les employés (une seule requête légère, pas 14 jours).
  async function loadDashboardLogs(){
    if (!sb || !session || !(session.is_admin || TABLET_MODE)) return;
    var ds = dateKey();
    var res = await sb.from('logs').select('id,done,blocked').eq('date', ds);
    if (res.error) return;
    var next = {};
    (res.data || []).forEach(function(row){ next[row.id] = { done: !!row.done, blocked: !!row.blocked }; });
    todayLogsAll = next;
    renderAdminDashboard();
    renderAdminEmployees();
    renderAdminCompanyOverview();
  }

  async function seedExamplesIfEmpty(){
    if (!session) return;
    if (allTaskList().length > 0) return;
    var rows = EXAMPLE_TASKS.map(function(ex){
      return { title: ex.title, time: ex.time, recurrence_type: ex.recurrence_type, recurrence_days: ex.recurrence_days, example: true, owner_employee_id: session.id, is_mandatory: false };
    });
    var res = await sb.from('tasks').insert(rows).select();
    if (!res.error){
      (res.data || []).forEach(function(row){ tasks[row.id] = rowToTask(row); });
      renderAll();
    }
  }

  async function addTask(title, time, recurrence){
    if (!sb || !session || isReadOnlyView()) return;
    var res = await sb.from('tasks').insert(Object.assign({
      title: title, time: time,
      owner_employee_id: session.id,
      is_mandatory: false
    }, recurrenceToRow(recurrence))).select();
    if (res.error){ toast('Ajout impossible.'); return; }
    var row = res.data && res.data[0];
    if (row){ tasks[row.id] = rowToTask(row); renderAll(); }
  }

  // Modifie une tâche existante en place (perso ou obligatoire — pour les
  // obligatoires, voir aussi mt-save qui gère en plus les destinataires).
  // Comme l'heure ou la fréquence peuvent changer, on annule d'abord les
  // rappels déjà programmés pour cette tâche puis on relance une synchro,
  // sinon un ancien rappel (à la mauvaise heure) pourrait sonner quand même.
  async function updateTask(id, title, time, recurrence){
    if (!sb || isReadOnlyView()) return;
    var res = await sb.from('tasks').update(Object.assign({
      title: title, time: time
    }, recurrenceToRow(recurrence))).eq('id', id).select();
    if (res.error){ toast('Modification impossible.'); return; }
    var row = res.data && res.data[0];
    if (row){
      tasks[row.id] = rowToTask(row);
      renderAll();
      if (session && session.is_admin) renderAdminTasks();
    }
    fetch('/api/cancel-task-notifications?task_id=' + encodeURIComponent(id)).then(function(){
      fetch('/api/sync-notifications').catch(function(){});
    }).catch(function(){});
  }

  async function deleteTask(id){
    if (!sb || isReadOnlyView()) return;
    var t = tasks[id];
    if (t && t.isMandatory && !(session && session.is_admin)){ toast('Seul le patron peut supprimer une tâche obligatoire.'); return; }
    delete tasks[id];
    delete assignees[id];
    renderAll();
    if (session && session.is_admin) renderAdminTasks();
    var res = await sb.from('tasks').delete().eq('id', id);
    if (res.error)
