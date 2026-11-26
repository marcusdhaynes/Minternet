/* Minternet's source of update metadata is published GitHub Releases.
 * An Actions artifact is not a public release and must not be reported as one.
 * Keep network errors distinct from "already up to date" and "not published".
 */
(function () {
  'use strict';
  const REPO='marcusdhaynes/Minternet';
  const API='https://api.github.com/repos/'+REPO;
  const RELEASES='https://github.com/'+REPO+'/releases';
  const CACHE_KEY='minternet.updates.last-verified.v2';
  const REQUEST_TIMEOUT=12000;
  // The five-second background poll hits a tiny GitHub Pages JSON feed, NOT
  // the authenticated/rate-limited GitHub REST API. Manual checks continue to
  // verify Releases against GitHub and the native installer verifies SHA-256.
  const FEED='https://marcusdhaynes.github.io/Minternet/update-feed.json';
  const POLL_KEY='minternet.updates.interval-seconds.v1';
  const DEFAULT_POLL_SECONDS=5;
  const MAX_FEED_AGE_SECONDS=600; // status snapshots must not appear live forever
  const MIN_POLL_SECONDS=5,MAX_POLL_SECONDS=3600;
  const WINDOWS_RUNS='/actions/workflows/native-windows.yml/runs?branch=main&per_page=5';
  let pipeline={kind:'unknown',title:'Checking Build Status',detail:'Waiting for GitHub Actions…'};
  let pipelineCheck=null,readyFromPipeline=null,displayedRelease=null,pollingStarted=false;
  let pollTimer=null,pollInFlight=null,lastFeedSignature='',lastFeedPollAt=0;
  function normalizePollSeconds(input){
    const seconds=Number(input);
    return Number.isSafeInteger(seconds) &&
      seconds>=MIN_POLL_SECONDS && seconds<=MAX_POLL_SECONDS?seconds:DEFAULT_POLL_SECONDS;
  }
  function storedPollSeconds(){
    try{return normalizePollSeconds(localStorage.getItem(POLL_KEY)||DEFAULT_POLL_SECONDS);}
    catch{return DEFAULT_POLL_SECONDS;}
  }
  let pollSeconds=storedPollSeconds();
  let installed='0.1.0'; // Only the web/demo fallback; native version comes from Rust.
  let lastStatus=null;
  let checking=null;
  const $=id=>document.getElementById(id);
  const clean=v=>String(v||'').trim().replace(/^v/i,'');
  function versionParts(v){
    const m=/^(\d+)\.(\d+)\.(\d+)(?:-build\.(\d+)(?:-g[0-9a-f]+)?)?/i.exec(clean(v));
    return m?[Number(m[1]),Number(m[2]),Number(m[3]),Number(m[4]||0)]:null;
  }
  function isNewer(candidate,current){
    const a=versionParts(candidate), b=versionParts(current);
    if(!a||!b)return false;
    for(let i=0;i<a.length;i++){if(a[i]!==b[i])return a[i]>b[i];}
    return false;
  }
  function dismissKey(version){return 'updates:dismissed:'+version;}
  function isDismissed(version){try{return localStorage.getItem(dismissKey(version))!==null;}catch{return false;}}
  function dismissVersion(version){try{localStorage.setItem(dismissKey(version),'1');}catch{}}
  async function getInstalledVersion(){
    if(window.__TAURI__&&window.minternet?.command){
      const result=await window.minternet.command('app-version');
      if(result?.version&&versionParts(result.version))installed=clean(result.version);
    }
    return installed;
  }
  function cached(){
    try{
      const parsed=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');
      if(parsed&&parsed.release&&versionParts(parsed.release.version))return parsed.release;
    }catch{}
    return null;
  }
  function saveCache(release){
    try{localStorage.setItem(CACHE_KEY,JSON.stringify({release,checkedAt:Date.now()}));}catch{}
  }
  function convertRelease(data){
    if(!data||data.draft||data.prerelease||!versionParts(data.tag_name))return null;
    const assets=Array.isArray(data.assets)?data.assets:[];
    const asset=assets.find(a=>/\.exe$/i.test(a.name||'') && /Minternet-Windows-Portable/i.test(a.name||''))
      ||assets.find(a=>/\.exe$/i.test(a.name||''));
    // Only a fully published Windows build is actionable by the Windows app.
    if(window.__TAURI__ && !asset)return null;
    return {
      version:clean(data.tag_name),tag:String(data.tag_name),
      notes:String(data.body||''),url:String(data.html_url||RELEASES),
      downloadUrl:asset?.browser_download_url||null
    };
  }
  async function request(path){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);
    try{
      const response=await fetch(API+path,{
        headers:{'Accept':'application/vnd.github+json'},
        cache:'no-store',signal:controller.signal
      });
      if(response.status===404)return {status:404,data:null};
      if(!response.ok)throw new Error(response.status===403||response.status===429
        ? 'GitHub temporarily limited update checks ('+response.status+').'
        : 'GitHub returned HTTP '+response.status+'.');
      return {status:response.status,data:await response.json()};
    }finally{clearTimeout(timeout);}
  }
  async function findPublishedRelease(){
    // GitHub's /releases/latest is a label, not a guarantee of the highest
    // version. Older parallel builds can finish later. Compare stable,
    // installable releases by embedded build number instead.
    let error=null;
    for(let attempt=0;attempt<2;attempt++){
      let latest=null,list=[];
      try{
        const result=await request('/releases/latest');
        latest=convertRelease(result.data);
      }catch(err){error=err;}
      try{
        // Draft-only pages can hide hundreds of older verified Windows
        // releases. Keep scanning within a bounded budget until we have
        // reached the real published results, not just the first 100 drafts.
        let verifiedPages=0;
        for(let page=1;page<=10;page++){
          const result=await request('/releases?per_page=100&page='+page);
          const entries=Array.isArray(result.data)?result.data:[];
          const valid=entries.map(convertRelease).filter(Boolean);
          list.push(...valid);
          if(valid.length)verifiedPages++;
          if(entries.length<100||verifiedPages>=2)break;
        }
      }catch(err){error=err;}
      const releases=[...list];
      if(latest&&!releases.some(item=>item.tag===latest.tag))releases.push(latest);
      releases.sort((a,b)=>isNewer(a.version,b.version)?-1:isNewer(b.version,a.version)?1:0);
      if(releases.length)return {release:releases[0]};
      if(!error)return {release:null,unpublished:true};
      if(attempt===0)await new Promise(ok=>setTimeout(ok,400));
    }
    throw error||new Error('GitHub release verification is unavailable.');
  }
  // A source commit is NOT an installable update. Compare it only to
  // explain why the installed latest verified release can lag behind main.
  // The update button is still offered exclusively for a published release
  // with a matching Windows EXE and checksum.
  async function sourcePublicationState(release){
    const tag=String(release?.tag||'');
    const match=tag.match(/-g([0-9a-f]{8,40})$/i);
    if(!match)return {kind:'unknown'};
    try{
      const latest=await request('/branches/main');
      const sha=String(latest.data?.commit?.sha||'').toLowerCase();
      if(!/^[0-9a-f]{40}$/.test(sha))return {kind:'unknown'};
      return sha.startsWith(match[1].toLowerCase())
        ?{kind:'current',sha}
        :{kind:'pending',sha};
    }catch{return {kind:'unknown'};}
  }

  function classifyPipelineRun(run,head){
    if(!run)return {kind:'unknown',title:'Build Status Unavailable',detail:'No Windows build was returned.'};
    const sha=String(run.head_sha||'').toLowerCase();
    const source=String(head||'').toLowerCase();
    const number=Number(run.run_number);
    const meta=Number.isSafeInteger(number)&&number>0?'Build #'+number+' · '+sha.slice(0,8):'Windows build';
    const url=String(run.html_url||'');
    const link=/^https:\/\/github\.com\/marcusdhaynes\/Minternet\/actions\/runs\/[0-9]+$/.test(url)?url:null;
    const result=(kind,title,detail)=>({kind,title,detail,meta,link});
    if(/^[0-9a-f]{40}$/.test(source)&&source!==sha)
      return result('pending','Update Pending','The newest source commit is awaiting its Windows build.');
    if(['queued','requested','waiting','pending'].includes(run.status))
      return result('initiating','Update Initiating','GitHub has queued the Windows build.');
    if(run.status==='in_progress')
      return result('building','Update Building','Windows compilation and tests are running.');
    if(run.status==='completed'&&run.conclusion==='success')
      return result('publishing','Update Publishing','Tests passed; awaiting the published Windows EXE and checksum.');
    if(run.status==='completed'&&['failure','cancelled','timed_out','action_required'].includes(run.conclusion))
      return result('failed','Update Failed','The Windows build did not pass. No update will be installed from this run.');
    return result('unknown','Build Status Unavailable','GitHub returned an unknown build state.');
  }
  function expectedTagForRun(run){
    const base=String(lastStatus?.releaseVersion||installed).match(/^\d+\.\d+\.\d+/)?.[0];
    const sha=String(run?.head_sha||'');
    const n=Number(run?.run_number);
    return base&&/^[0-9a-f]{40}$/i.test(sha)&&Number.isSafeInteger(n)&&n>0
      ?'v'+base+'-build.'+n+'-g'+sha.slice(0,8).toLowerCase():null;
  }
  // Readiness requires the *exact* successful run's public Windows release.
  // Green Actions checks, drafts, unrelated EXEs and missing checksums do not count.
  function verifiedReleaseForRun(run,release,tag){
    if(!run||run.status!=='completed'||run.conclusion!=='success'||
       !tag||release?.tag_name!==tag||release.target_commitish!==run.head_sha||
       release.draft||release.prerelease)return null;
    const assets=Array.isArray(release.assets)?release.assets:[];
    const prefix='https://github.com/'+REPO+'/releases/download/'+tag+'/';
    const exe='Minternet-Windows-Portable-'+tag+'.exe';
    const asset=(name)=>assets.find(a=>a?.name===name&&Number(a.size)>0&&
      a.browser_download_url===prefix+encodeURIComponent(name));
    const binary=asset(exe);
    if(!binary||Number(binary.size)<100000||Number(binary.size)>=50000000||
       !asset('SHA256SUMS.txt'))return null;
    return convertRelease(release);
  }
  const preferredRelease=info=>readyFromPipeline&&
    (!info||isNewer(readyFromPipeline.version,info.version))?readyFromPipeline:info;
  async function refreshPipelineStatus(){
    if(pipelineCheck)return pipelineCheck;
    pipelineCheck=(async()=>{
      if(!window.__TAURI__)return pipeline;
      try{
        const result=await request(WINDOWS_RUNS);
        const runs=Array.isArray(result.data?.workflow_runs)?result.data.workflow_runs:[];
        const run=runs.find(r=>r?.head_branch==='main');
        let next=classifyPipelineRun(run,lastStatus?.sourceSha);
        if(next.kind==='publishing'){
          const tag=expectedTagForRun(run);
          if(tag){
            const response=await request('/releases/tags/'+encodeURIComponent(tag));
            const published=verifiedReleaseForRun(run,response.data,tag);
            if(published){
              next={...next,kind:'ready',title:'Update Ready',
                detail:'The verified Windows EXE and checksum are published.'};
              if(isNewer(published.version,installed)){
                readyFromPipeline=published;
                saveCache(published);
                lastStatus={kind:'verified',releaseVersion:published.version,
                  sourceSha:run.head_sha,
                  message:'New verified Minternet update available: v'+published.version+'.'};
              }else{
                next={...next,kind:'current',title:'Up To Date',
                  detail:'This published Windows build is already installed.'};
              }
            }
          }
        }
        pipeline=next;
      }catch(error){
        pipeline={kind:'unavailable',title:'Live Status Unavailable',
          detail:String(error?.message||'GitHub Actions could not be checked.')};
      }
      return pipeline;
    })().finally(()=>{pipelineCheck=null;});
    return pipelineCheck;
  }
  function renderPipeline(el){
    if(!window.__TAURI__)return;
    const panel=document.createElement('div');panel.className='updates-live-pipeline';
    panel.dataset.state=pipeline.kind;
    const header=document.createElement('div');header.className='updates-live-head';
    const heading=document.createElement('strong');heading.textContent='Live Windows Update';
    const phase=document.createElement('span');phase.textContent=pipeline.title;
    phase.className='updates-live-phase';header.append(heading,phase);
    const stages=document.createElement('div');stages.className='updates-live-steps';
    const at={initiating:0,building:1,publishing:1,failed:1,ready:2,current:2};
    const index=Object.prototype.hasOwnProperty.call(at,pipeline.kind)?at[pipeline.kind]:-1;
    ['Initiating','Building','Ready'].forEach((name,i)=>{
      const chip=document.createElement('span');chip.textContent=name;
      chip.dataset.step=index<0||i>index?'waiting':i<index?'complete':
        pipeline.kind==='failed'?'failed':'active';
      stages.append(chip);
    });
    const note=document.createElement('div');note.className='updates-live-detail';
    note.textContent=pipeline.detail||'';
    const footer=document.createElement('div');footer.className='updates-live-foot';
    const meta=document.createElement('span');meta.textContent=pipeline.meta||'';
    footer.append(meta);
    if(pipeline.link){
      const anchor=document.createElement('a');anchor.href=pipeline.link;
      anchor.target='_blank';anchor.rel='noopener';anchor.textContent='View Build';
      footer.append(anchor);
    }
    const interval=document.createElement('div');interval.className='updates-live-refresh';
    interval.textContent='Checks for new updates every '+pollSeconds+
      (pollSeconds===1?' second':' seconds')+' · verified release feed';
    panel.append(header,stages,note,footer,interval);el.append(panel);
  }
  async function checkForUpdate(){
    if(checking)return checking;
    checking=(async()=>{
      await getInstalledVersion();
      try{
        const found=await findPublishedRelease();
        if(found.unpublished){
          lastStatus={kind:'unpublished',message:'No verified Windows release is published yet.'};
          return null;
        }
        saveCache(found.release);
        const updateAvailable=isNewer(found.release.version,installed);
        const published='v'+found.release.version;
        // Never claim "up to date" with all source changes while Windows CI
        // is still building or testing a newer commit on main. Pending source
        // does not activate the install button or bypass binary checks.
        const publication=updateAvailable||!window.__TAURI__
          ?{kind:'current'}:await sourcePublicationState(found.release);
        lastStatus={
          kind:publication.kind==='pending'?'pending':
            publication.kind==='unknown'?'verification-unknown':'verified',
          releaseVersion:found.release.version,
          sourceSha:publication.sha||null,
          message:updateAvailable
            ?'New verified Minternet update available: '+published+'.'
            :publication.kind==='pending'
              ?'A newer Minternet source update is pending its verified Windows release. '+published+' remains the latest installable version.'
              :publication.kind==='unknown'
                ?'Latest installable release: '+published+'. Unable to verify whether newer source changes are pending.'
                :'Up to date — you have the latest published and verified Minternet Windows release ('+published+').'
        };
        return updateAvailable?found.release:null;
      }catch(err){
        const previous=cached();
        lastStatus={kind:'offline',message:(err?.name==='AbortError'
          ? 'GitHub did not respond in time.':String(err?.message||'Unable to connect to GitHub.'))
          +(previous?' Showing the last verified release.':' Check your connection and retry.')};
        return previous&&isNewer(previous.version,installed)?{...previous,cached:true}:null;
      }
    })().finally(()=>{checking=null;});
    return checking;
  }
  async function applyUpdate(info){
    if(window.__TAURI__){
      if(!window.minternet?.command){
        window.minternetToast?.('Native update service is unavailable.');
        return;
      }
      const section=$('updatesSection');
      if(section)renderSection(section,info,'Preparing verified update…');
      const result=await window.minternet.command('update-install');
      if(result?.message){
        if(section)renderSection(section,info,result.message);
        window.minternetToast?.(result.message);
      }
      // A separate native helper performs replacement/relaunch. Do not
      // navigate away, fake installation, or open GitHub in another browser.
      return;
    }
    // The web companion is deployed through GitHub Pages.
    window.location.reload();
  }
  // Compact Settings presentation retained from the modern Nov 13 interface.
  // Never replace the verified native updater or its version comparison.
  function renderSection(el,info,status,checking=false){
    el.replaceChildren();
    const versions=document.createElement('div');versions.className='updates-versions';
    function versionRow(label,value){
      const row=document.createElement('div');row.className='updates-version-row';
      const caption=document.createElement('span');caption.textContent=label;
      const number=document.createElement('strong');number.textContent=value;
      row.append(caption,number);return row;
    }
    versions.append(versionRow('Installed Version','v'+installed));
    if(lastStatus?.releaseVersion)
      versions.append(versionRow('Latest Published Release','v'+lastStatus.releaseVersion));
    if(info)versions.append(versionRow('Available Update','v'+info.version));
    if(lastStatus?.kind==='pending' && lastStatus.sourceSha)
      versions.append(versionRow('Latest Source (Pending Release)',lastStatus.sourceSha.slice(0,8)));
    el.append(versions);
    renderPipeline(el);
    // Control lives in Updates (not a separate global Settings menu). A
    // change immediately reschedules the singleton background poll.
    const pollRow=document.createElement('label');
    pollRow.className='updates-poll-setting';
    pollRow.setAttribute('for','updatesPollSeconds');
    const pollLabel=document.createElement('span');
    pollLabel.textContent='Check Every';
    const pollInput=document.createElement('input');
    pollInput.id='updatesPollSeconds';
    pollInput.type='number';
    pollInput.min=String(MIN_POLL_SECONDS);
    pollInput.max=String(MAX_POLL_SECONDS);
    pollInput.step='1';
    pollInput.value=String(pollSeconds);
    pollInput.setAttribute('inputmode','numeric');
    pollInput.setAttribute('aria-label','Automatic update check interval in seconds');
    pollInput.addEventListener('change',()=>{
      const value=normalizePollSeconds(pollInput.value);
      setPollSeconds(value);
      pollInput.value=String(pollSeconds);
    });
    const unit=document.createElement('span');unit.textContent='seconds';
    pollRow.append(pollLabel,pollInput,unit);
    el.append(pollRow);
    const message=document.createElement('div');message.className='updates-current-status';
    message.setAttribute('role','status');message.setAttribute('aria-live','polite');
    message.textContent=status||'';
    message.dataset.state=checking?'checking':
      lastStatus?.kind==='offline'?'error':
      lastStatus?.kind==='unpublished'?'unpublished':
      lastStatus?.kind==='pending'?'pending':
      lastStatus?.kind==='verification-unknown'?'unknown':info?'available':'current';
    el.append(message);
    if(info?.notes){
      const notes=document.createElement('details');notes.className='updates-release-notes';
      const summary=document.createElement('summary');summary.textContent="What's New";
      const body=document.createElement('p');body.textContent=info.notes;
      notes.append(summary,body);el.append(notes);
    }
    if(lastStatus?.kind==='unpublished'){
      const link=document.createElement('a');link.href=RELEASES;
      link.target='_blank';link.rel='noopener';link.textContent='View GitHub Releases';
      el.append(link);
    }
    const controls=document.createElement('div');controls.className='updates-actions';
    const check=document.createElement('button');check.type='button';
    check.className='updates-check-button';
    check.textContent=checking?'Checking…':'Check for Updates';
    check.disabled=Boolean(checking);check.addEventListener('click',()=>{void mountSection(el);});
    controls.append(check);
    if(info){
      const update=document.createElement('button');update.type='button';
      update.className='updates-install-button';
      update.textContent=info.cached?'Install Last Verified Update':
        window.__TAURI__?'Install & Restart · v'+info.version:'Get v'+info.version;
      update.addEventListener('click',()=>{void applyUpdate(info);});controls.append(update);
    }
    el.append(controls);
  }
  async function mountSection(el){
    renderSection(el,null,'Checking GitHub Releases…',true);
    const info=await checkForUpdate();
    await refreshPipelineStatus();
    displayedRelease=preferredRelease(info);
    renderSection(el,displayedRelease,lastStatus?.message||'Unable to verify update status.');
  }
  function verifiedFeedRelease(value){
    if(!value||typeof value!=='object')return null;
    const tag=String(value.tag||'');
    if(!/^v\d+\.\d+\.\d+-build\.\d+-g[0-9a-f]{8}$/.test(tag)||
       value.version!==tag.slice(1)||!versionParts(value.version)||
       !/^[0-9a-f]{40}$/i.test(String(value.sourceSha||'')))return null;
    const prefix='https://github.com/'+REPO+'/releases/download/'+tag+'/';
    const executable='Minternet-Windows-Portable-'+tag+'.exe';
    if(value.downloadUrl!==prefix+executable ||
       value.checksumUrl!==prefix+'SHA256SUMS.txt')return null;
    return {
      version:value.version,tag,notes:String(value.notes||'').slice(0,2000),
      url:String(value.url||RELEASES),downloadUrl:value.downloadUrl,
      sourceSha:value.sourceSha
    };
  }
  // Frequent checks use a tiny static Pages feed; an installed EXE is still
  // verified against GitHub Releases and SHA256SUMS by the native updater.
  // This keeps 5s polling viable without exhausting GitHub's 60/hour API cap.
  async function refreshLiveFeed(el){
    if(pollInFlight)return pollInFlight;
    pollInFlight=(async()=>{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);
      try{
        const response=await fetch(FEED,{cache:'no-store',signal:controller.signal});
        if(!response.ok)throw Error('Update feed HTTP '+response.status);
        const feed=await response.json();
        if(feed?.schema!==1||
           !/^[0-9a-f]{40}$/i.test(String(feed.sourceSha||''))){
          throw Error('Unrecognized update feed');
        }
        const release=verifiedFeedRelease(feed.release);
        if(feed.release && !release)throw Error('Update feed release was not verified');
        const latestRun=feed.windowsRun&&typeof feed.windowsRun==='object'
          ?feed.windowsRun:null;
        const generatedAt=Number(feed.generatedAt);
        const feedAgeSeconds=Math.floor(Date.now()/1000)-generatedAt;
        const stale=!Number.isSafeInteger(generatedAt)||
          !Number.isFinite(feedAgeSeconds)||feedAgeSeconds>MAX_FEED_AGE_SECONDS||
          feedAgeSeconds< -120;
        const signature=JSON.stringify([stale,feed.sourceSha,
          latestRun?.head_sha,latestRun?.status,latestRun?.conclusion,
          latestRun?.run_number,release?.version]);
        lastFeedPollAt=Date.now();
        if(signature===lastFeedSignature)return release;
        lastFeedSignature=signature;
        const newer=release&&isNewer(release.version,installed);
        if(release){
          saveCache(release);
          if(newer&&(!readyFromPipeline||isNewer(release.version,readyFromPipeline.version)))readyFromPipeline=release;
          displayedRelease=preferredRelease(newer?release:null);
        }
        pipeline=classifyPipelineRun(latestRun,feed.sourceSha);
        if(stale&&!newer){
          pipeline={...pipeline,kind:'unavailable',title:'Status Feed Delayed',
            detail:'GitHub build status snapshot is outdated. Open View Build for live GitHub status.'};
        }
        if(newer){
          pipeline={...pipeline,kind:'ready',title:'Update Ready',
            detail:'A published Windows EXE and checksum are available.'};
          lastStatus={kind:'verified',releaseVersion:release.version,
            sourceSha:feed.sourceSha,
            message:'New verified Minternet update available: v'+release.version+'.'};
        }else if(release){
          const sourcePending=feed.sourceSha.toLowerCase()!==
            String(release.sourceSha).toLowerCase();
          if(!sourcePending && pipeline.kind==='publishing'){
            pipeline={...pipeline,kind:'current',title:'Up To Date',
              detail:'This published Windows build is already installed.'};
          }
          lastStatus={kind:sourcePending?'pending':'verified',
            releaseVersion:release.version,sourceSha:feed.sourceSha,
            message:sourcePending
              ?(pipeline.kind==='failed'?'The newest Windows build failed. ':'New Minternet source is pending its verified Windows release. ')+
                'v'+release.version+' is the newest published update.'
              :'Up to date — latest published Windows release: v'+release.version+'.'};
        }else if(!lastStatus){
          lastStatus={kind:'unpublished',
            message:'No published Windows build is available in the update feed.'};
        }
        if(stale&&!newer&&lastStatus){
          lastStatus={...lastStatus,kind:'verification-unknown',
            message:'Build status feed is outdated; the newest source/build state is unverified. '+
              'The last published verified release remains available.'};
        }
        if(el)renderSection(el,displayedRelease,
          lastStatus?.message||'Checking update status…');
        if(displayedRelease&&isNewer(displayedRelease.version,installed)&&!isDismissed(displayedRelease.version))mountRibbon(displayedRelease);
        return release;
      }catch(error){
        // A failed feed must never mean "up to date". Keep any previously
        // verified release and allow the manual GitHub API check to work.
        // Do not preserve a previously queued/initiating state indefinitely
        // when the source of live information has become unreachable.
        lastFeedSignature='';
        pipeline={kind:'unavailable',title:'Live Status Unavailable',
          detail:'Fast status feed unavailable. Use Check for Updates for a direct GitHub check.'};
        if(el)renderSection(el,displayedRelease,
          'Live build status could not be refreshed; published release data may be older.');
        return null;
      }finally{clearTimeout(timeout);}
    })().finally(()=>{pollInFlight=null;});
    return pollInFlight;
  }
  function scheduleNextPoll(){
    if(pollTimer!==null)clearTimeout(pollTimer);
    if(!pollingStarted)return;
    pollTimer=setTimeout(()=>{
      pollTimer=null;
      const el=$('updatesSection');
      // Keep checking even when Settings is closed; the ribbon should show
      // new verified releases without requiring the user to reopen Settings.
      void refreshLiveFeed(el).finally(scheduleNextPoll);
    },pollSeconds*1000);
  }
  function setPollSeconds(seconds){
    pollSeconds=normalizePollSeconds(seconds);
    try{localStorage.setItem(POLL_KEY,String(pollSeconds));}catch{}
    scheduleNextPoll();
    const el=$('updatesSection');
    if(el)renderSection(el,displayedRelease,
      lastStatus?.message||'Automatic update checks configured.');
    return pollSeconds;
  }
  function startPipelinePolling(el){
    if(pollingStarted||!window.__TAURI__)return;
    pollingStarted=true;
    const disclosure=el.closest?.('details');
    disclosure?.addEventListener('toggle',()=>{
      if(disclosure.open)void refreshLiveFeed(el);
    });
    window.addEventListener?.('storage',event=>{
      if(event.key!==POLL_KEY)return;
      pollSeconds=storedPollSeconds();
      scheduleNextPoll();
      renderSection(el,displayedRelease,
        lastStatus?.message||'Checking update status…');
    });
    scheduleNextPoll();
  }
  function mountRibbon(info){
    if(!info||info.cached||!isNewer(info.version,installed))return;
    const existing=$('museUpdateRibbon');
    if(existing?.dataset.version===info.version)return;
    existing?.remove();
    const ribbon=document.createElement('div');ribbon.id='museUpdateRibbon';ribbon.dataset.version=info.version;
    ribbon.setAttribute('role','button');
    ribbon.setAttribute('aria-label','Update available, version '+info.version);
    ribbon.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:8px;padding:3px 6px 3px 12px;border-radius:999px;font-size:12px;line-height:1.4;background:rgba(127,127,127,.16);border:1px solid rgba(127,127,127,.35);backdrop-filter:blur(6px);cursor:pointer;';
    const label=document.createElement('span');label.textContent='Update available · v'+info.version;
    const close=document.createElement('button');close.type='button';close.textContent='×';
    close.setAttribute('aria-label','Dismiss this update');
    close.addEventListener('click',event=>{event.stopPropagation();dismissVersion(info.version);ribbon.remove();});
    ribbon.append(label,close);ribbon.addEventListener('click',()=>applyUpdate(info));
    document.body.append(ribbon);
  }
  // Download progress and errors originate in the trusted native updater.
  // An installed browser remains open if verification or helper startup fails.
  if(window.__TAURI__?.event?.listen){
    void window.__TAURI__.event.listen('minternet:update',event=>{
      const payload=event.payload||{};
      const section=$('updatesSection');
      if(section){
        const status=section.querySelector('[role="status"]');
        if(status)status.textContent=String(payload.message||'');
      }
      if(payload.kind==='error')window.minternetToast?.(String(payload.message||'Update failed'));
    }).catch(()=>{});
  }
  window.MuseUpdates={
    get CURRENT_VERSION(){return installed;},isNewer,checkForUpdate,applyUpdate,mountSection,mountRibbon,
    classifyPipelineRun,expectedTagForRun,verifiedReleaseForRun,refreshPipelineStatus,
    verifiedFeedRelease,refreshLiveFeed,setPollSeconds,startPipelinePolling,
    get updateCheckSeconds(){return pollSeconds;},
    get lastFeedPollAt(){return lastFeedPollAt;},
    get livePipeline(){return pipeline;},
    get lastStatus(){return lastStatus;}
  };
  async function init(){
    const el=$('updatesSection');
    if(el){await mountSection(el);startPipelinePolling(el);}
    else await getInstalledVersion();
    const info=preferredRelease(await checkForUpdate());
    if(info&&!isDismissed(info.version))mountRibbon(info);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>void init());
  else void init();
})();
