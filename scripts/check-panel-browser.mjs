import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { panelStyles } from './panel-styles.mjs';

// Surface failures through check annotations when CI log downloads are unavailable.
process.on('uncaughtException', error => {
  const message = String(error.message).slice(0, 8000).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  if (process.env.GITHUB_ACTIONS) console.error(`::error title=Lit UI browser check::${message}`);
  console.error(error.stack || error);
  process.exit(1);
});

const directory = await mkdtemp(path.join(tmpdir(), 'sn-export-panel-'));
const entry = `
import { ExportPanel } from ${JSON.stringify(path.resolve('src/ui/panel.ts'))};
import { installContent } from ${JSON.stringify(path.resolve('src/extension/content.ts'))};
// Simulate a realm where native custom-element constructors are unusable.
Object.defineProperty(globalThis, 'customElements', { configurable: true, value: {
  define() { throw new TypeError('Illegal constructor.'); },
  get() { throw new TypeError('Illegal constructor.'); },
} });
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  const themeStore={};
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{storage:{local:{get:async()=>({...themeStore}),set:async values=>Object.assign(themeStore,values)}}}});
  const panel = new ExportPanel();
  document.body.append(panel.element);
  const context = { table: 'incident', filter: 'active=true', rowCount: 25001, frameId:7, view:'ess' };
  panel.receiveContext(context);
  panel.receiveRun(null);
  await panel.updateComplete;
  const root = panel.shadowRoot;
  assert(root.querySelector('#query').value === 'active=true', 'Prefill query');
  const themeToggle=root.querySelector('#toggle-dark-mode');
  assert(themeToggle.nextElementSibling.id==='minimize-export','Theme toggle sits immediately before minimize');
  themeToggle.click();await panel.updateComplete;
  assert(panel.darkMode && root.querySelector('#toggle-dark-mode').getAttribute('aria-pressed')==='true','Toggle activates dark mode');
  assert(getComputedStyle(root.querySelector('section')).backgroundColor==='rgb(15, 23, 42)','Panel uses a dark surface');
  assert(getComputedStyle(root.querySelector('#query')).backgroundColor==='rgb(15, 23, 42)','Inputs use dark surfaces too');
  root.querySelector('#toggle-dark-mode').click();await panel.updateComplete;
  assert(!panel.darkMode && getComputedStyle(root.querySelector('section')).backgroundColor==='rgb(255, 255, 255)','Toggle restores light mode');
  for(let step=0;step<10;step++)await Promise.resolve();
  assert(themeStore['sn-export-theme']==='light','Explicit theme choice is saved');
  themeStore['sn-export-theme']='dark';
  const restoredTheme=new ExportPanel();await Promise.resolve();await restoredTheme.updateComplete;
  assert(restoredTheme.darkMode,'Stored theme is restored when the panel is recreated');
  restoredTheme.remove();themeStore['sn-export-theme']='light';
  assert(!root.querySelector('#filename-prefix'),'Filename hidden before attachments exist');
  assert(root.querySelector('#chunk-size').max === '', 'Target has no hardcoded maximum');
  assert(root.querySelector('#file-type').value === 'csv', 'CSV default');
  assert([...root.querySelectorAll('select, textarea, input')].map(node=>node.id).join(',')==='file-type,display-values,fields,query,chunk-size,concurrency,poll-interval','Requested field order');
  assert(root.querySelector('#display-values').checked, 'Display values default');
  assert(root.querySelector('#chunk-size').value === '8000', '8,000 target default');
  const input = (selector, value, type = 'input') => {
    const element = root.querySelector(selector); element.value = value;
    element.dispatchEvent(new Event(type, { bubbles:true }));
  };
  const stepButton = label => root.querySelector('button[aria-label="'+label+'"]');
  stepButton('Increase Target rows per chunk').click();await panel.updateComplete;
  assert(root.querySelector('#chunk-size').value==='9000','Chunk stepper increases the target');
  stepButton('Decrease Target rows per chunk').click();await panel.updateComplete;
  assert(root.querySelector('#chunk-size').value==='8000','Chunk stepper decreases the target');
  for (const [rows, increment] of [[100,1],[101,10],[1000,10],[1001,100],[10000,100],[10001,1000]]) {
    panel.receiveContext({...context,rowCount:rows});panel.receiveRun(null);await panel.updateComplete;
    input('#chunk-size','2000');await panel.updateComplete;
    stepButton('Increase Target rows per chunk').click();await panel.updateComplete;
    assert(root.querySelector('#chunk-size').value===String(2000+increment),'Chunk increment follows list count '+rows);
    input('#chunk-size','2');await panel.updateComplete;
    stepButton('Decrease Target rows per chunk').click();await panel.updateComplete;
    assert(root.querySelector('#chunk-size').value==='1' && stepButton('Decrease Target rows per chunk').disabled,'Chunk decrement cannot reach zero');
  }
  panel.receiveContext(context);panel.receiveRun(null);await panel.updateComplete;

  assert(stepButton('Increase Concurrent jobs').disabled,'Concurrent jobs cannot exceed chunk count');
  stepButton('Decrease Concurrent jobs').click();await panel.updateComplete;
  stepButton('Increase Concurrent jobs').click();await panel.updateComplete;
  stepButton('Decrease Status check interval (seconds)').click();await panel.updateComplete;
  assert(root.querySelector('#poll-interval').value==='1' && stepButton('Decrease Status check interval (seconds)').disabled,'Polling stepper respects minimum');
  stepButton('Increase Status check interval (seconds)').click();await panel.updateComplete;
  input('#file-type','xml','change');await panel.updateComplete;
  assert(root.querySelector('#fields').disabled && root.querySelector('#display-values').disabled,'XML disables field and value selection');
  input('#file-type','csv','change');await panel.updateComplete;
  assert(!root.querySelector('#fields').disabled && !root.querySelector('#display-values').disabled,'CSV restores field and value selection');

  assert(root.querySelector('#concurrency').value === '4' && root.querySelector('#concurrency').max === '4', 'Default all approximate chunks');
  assert([...root.querySelectorAll('option')].map(option => option.value).join(',') === 'csv,xlsx,xml,json', 'All requested formats');
  assert(root.querySelector('#poll-interval').value==='2','Default 2-second polling');
  input('#poll-interval','61');await panel.updateComplete;assert(root.querySelector('#review-export').disabled,'Reject polling outside bounds');
  input('#poll-interval','5');await panel.updateComplete;
  input('#fields','number');await panel.updateComplete;
  root.querySelector('#minimize-export').click();await panel.updateComplete;
  assert(root.querySelector('#restore-export') && getComputedStyle(root.querySelector('section')).display==='none','Minimize shows the floating button and hides the full panel');
  assert(panel.isConnected && !root.querySelector('#restore-export').textContent.includes('jobs completed'),'Minimizing idle panel keeps it mounted without job counts');
  root.querySelector('#restore-export').click();await panel.updateComplete;
  assert(root.querySelector('#fields').value==='number' && getComputedStyle(root.querySelector('section')).display==='flex','Restore preserves edited settings');
  input('#fields','');await panel.updateComplete;
  let submissions = [];
  panel.addEventListener('sn-export-start', event => submissions.push(event.detail));
  assert(submissions.length === 0, 'Opening never starts jobs');
  input('#chunk-size', '10000'); await panel.updateComplete;
  assert(root.querySelector('#concurrency').value === '3', 'Editable chunk target updates chunk count');
  input('#concurrency', '4'); await panel.updateComplete;
  assert(root.querySelector('#review-export').disabled, 'Reject concurrency above calculated maximum');
  input('#chunk-size','16000'); await panel.updateComplete;
  assert(root.querySelector('#concurrency').max === '2' && !root.querySelector('#review-export').disabled,'Allow chunk targets above 10,000');
  input('#chunk-size','10000');
  input('#concurrency','2'); input('#fields','number, caller_id'); input('#file-type','json','change');
  await panel.updateComplete;
  root.querySelector('#review-export').click(); await panel.updateComplete;
  assert(submissions.length === 0 && root.querySelector('#confirm-export'), 'Review requires a separate confirmation');
  assert(root.querySelector('#fields').disabled && root.querySelector('#fields-help').textContent.includes('not supported'),'JSON disables fields with help text');
  assert(root.textContent.includes('All accessible record fields') && root.textContent.includes('JSON'), 'Review describes full-record JSON export');
  root.querySelector('#confirm-export').click(); await panel.updateComplete;
  assert(submissions.length === 1 && submissions[0].confirmed === true, 'Only confirm dispatches the batch');
  assert(submissions[0].fields === '', 'JSON ignores the retained fields input');
  assert(submissions[0].filenamePrefix === undefined,'Export submission does not depend on download naming');
  assert(submissions[0].pollingIntervalSeconds===5,'Polling interval travels with the confirmation');
  assert(submissions[0].expectedRowCount === 25001 && submissions[0].expectedView === 'ess', 'Confirm exact list snapshot');
  const run = { id:'run-1', tabId:1, frameId:7, origin:'https://example.service-now.com', createdAt:1, revision:1, status:'running',
    settings:{table:'incident',query:'active=true',fileType:'json',fields:'number,caller_id',displayValues:true,view:'ess',rowCount:25001,targetChunkSize:10000,concurrency:2},
    jobs:[{id:1,query:'active=true',status:'running',jobId:'a'.repeat(32),exportedRows:80,totalRows:100,message:'exported 80 of 100 rows'},
      {id:2,query:'active=true',status:'running'},{id:3,query:'active=true',status:'queued'}] };
  panel.receiveRun(run); await panel.updateComplete;
  root.querySelector('#minimize-export').click();await panel.updateComplete;
  assert(root.querySelector('#restore-export').textContent.includes('0/3 jobs completed'),'Minimized view shows tracked progress');
  panel.receiveRun({...run,jobs:run.jobs.map((job,index)=>index===0?{...job,status:'completed'}:job)});await panel.updateComplete;
  assert(root.querySelector('#restore-export').textContent.includes('1/3 jobs completed'),'Minimized progress updates as jobs finish');
  panel.receiveRun(run);await panel.updateComplete;
  root.querySelector('#restore-export').click();await panel.updateComplete;
  assert(panel.run.id===run.id,'Restoring retains the same tracked export');
  assert(!root.querySelector('details').open,'Job details collapsed by default');
  assert(root.querySelector('[aria-label="Overall jobs completed"]').max===3,'Compact summary tracks all jobs');
  assert(!root.querySelector('#filename-prefix'),'Filename remains hidden during the run');
  assert(root.querySelector('fieldset').disabled, 'Freeze settings during active export');
  const timedRun={...run,createdAt:Date.now()-5000,revision:2};
  panel.receiveRun(timedRun);panel.clockNow=timedRun.createdAt+5000;await panel.updateComplete;
  assert(root.querySelector('#export-elapsed').textContent.includes('5s'),'Show batch elapsed time');
  assert(root.querySelectorAll('[data-job-card]').length===3 && !root.querySelector('[data-job-card] progress'),'Jobs use compact cards without linear progress bars');
  assert(root.querySelector('[data-job-card="1"] [role="progressbar"]').getAttribute('aria-valuenow')==='80','Circular progress reflects processor counts');
  assert(root.querySelector('[data-job-card="1"] circle[stroke-dasharray]').namespaceURI==='http://www.w3.org/2000/svg','Circular progress renders in the SVG namespace');
  assert(!root.querySelector('[data-job-card]').textContent.includes('Elapsed'),'No individual job timing');
  panel.clockNow+=2000;await panel.updateComplete;
  assert(root.querySelector('#export-elapsed').textContent.includes('7s'),'Live batch elapsed time advances');

  let cancelRequest;panel.addEventListener('sn-export-cancel',event=>{cancelRequest=event.detail});
  root.querySelector('#cancel-export').click();await panel.updateComplete;
  assert(!cancelRequest && root.querySelector('[role="alertdialog"]'),'Cancel export requires confirmation');
  root.querySelector('#keep-export').click();await panel.updateComplete;
  assert(!root.querySelector('#confirm-cancel-export') && !cancelRequest,'Dismiss cancellation without requests');
  root.querySelector('#cancel-export').click();await panel.updateComplete;
  root.querySelector('#confirm-cancel-export').click();await panel.updateComplete;
  assert(cancelRequest.runId===run.id && cancelRequest.confirmed===true,'Confirm sends batch cancellation');
  panel.operationFailed('Cancellation test finished');await panel.updateComplete;

  assert(root.querySelector('[data-job-card="1"] [role="progressbar"]').getAttribute('aria-valuenow') === '80', 'Use actual reported progress');
  panel.receiveContext(context); panel.receiveRun(run); await panel.updateComplete;
  assert(panel.run.id === 'run-1' && root.querySelector('#fields').value === 'number,caller_id', 'Restore run/settings on reopen');
  panel.receiveRun({...run,revision:2,status:'paused',message:'Connection interrupted'});await panel.updateComplete;
  assert(root.querySelector('#resume-checks') && root.querySelector('fieldset').disabled,'Resume stays accessible while settings are locked');
  let resumeRequested;panel.addEventListener('sn-export-resume',event=>{resumeRequested=event.detail});
  root.querySelector('#resume-checks').click();await panel.updateComplete;
  assert(resumeRequested.runId===run.id && panel.resuming,'Resume sends the existing run ID');
  panel.receiveRun({...run,revision:3,status:'paused',needsReview:true});await panel.updateComplete;
  assert(!root.querySelector('#resume-checks'),'Uncertain submissions cannot be resumed');
  panel.receiveRun({...run,revision:4});await panel.updateComplete;
  panel.receiveRun({...run,revision:0,status:'completed'}); await panel.updateComplete;
  assert(panel.run.status === 'running', 'Ignore stale run snapshots');
  panel.receiveRun({...run,revision:5,jobs:run.jobs.map((job,index)=>index===0?{...job,status:'completed',attachmentId:'b'.repeat(32)}:job)}); await panel.updateComplete;
  assert(!root.querySelector('#filename-prefix'),'Filename remains hidden with only some files ready');
  const finished = {...run,status:'completed',revision:5,jobs:run.jobs.map(job => ({...job,status:'completed',attachmentId:'b'.repeat(32)}))};
  panel.receiveRun(finished); await panel.updateComplete;
  assert(root.querySelector('#completeness-summary').textContent.includes('Processor totals'),'Show processor counts separately from file verification');
  panel.receiveRun({...finished,createdAt:1000,finishedAt:63000,revision:6});await panel.updateComplete;
  panel.clockNow+=2000;await panel.updateComplete;
  assert(root.querySelector('#export-elapsed').textContent.includes('1m 02s'),'Batch elapsed time freezes after completion');

  assert(root.querySelector('#filename-prefix').value==='incident','Download name defaults to run table');
  assert(!root.querySelector('#download-combined'),'Other formats keep separate downloads');
  assert(!root.querySelector('#completeness-summary').textContent.includes('CSV file rows:'),'Non-CSV exports hide CSV verification');
  input('#filename-prefix','My incidents'); await panel.updateComplete;
  panel.receiveRun({...finished,revision:7}); await panel.updateComplete;
  assert(root.querySelector('#filename-prefix').value==='My incidents','Run updates preserve the edited download name');
  let individualRequest;
  panel.addEventListener('sn-export-download-job',event=>{individualRequest=event.detail});
  root.querySelector('[data-download-job="2"]').click();await panel.updateComplete;
  assert(individualRequest.jobId===2 && individualRequest.filenamePrefix==='My incidents','Individual job button uses the chosen file and name');
  panel.downloadsRequested(1,0);await panel.updateComplete;
  let downloads=0; panel.addEventListener('sn-export-download-all',event=>{downloads++;assert(event.detail.filenamePrefix==='My incidents','Downloads use the chosen name')});
  root.querySelector('#download-all').click(); await panel.updateComplete;
  assert(downloads === 1 && panel.downloading, 'Download all emits a single batch request');
  assert(root.querySelector('footer #file-download-activity').textContent.includes('Requesting file downloads') && root.querySelector('#file-download-activity .animate-spin'),'Request processing has a visible footer spinner');
  assert(!root.querySelector('fieldset').disabled && root.querySelector('#download-all').disabled,'Settings stay editable while duplicate download requests are blocked');

  const inProgress={...finished,revision:9,jobs:finished.jobs.map((job,index)=>index===0?{...job,downloadId:99,downloadState:'in_progress'}:job)};
  panel.receiveRun(inProgress);panel.downloadsRequested(3,0);await panel.updateComplete;
  assert(root.querySelector('#file-download-activity').textContent.includes('1 downloading') && root.querySelector('#file-download-activity .animate-spin'),'Browser transfers retain an activity indicator after requests finish');
  panel.receiveRun({...inProgress,revision:10,jobs:inProgress.jobs.map(job=>job.downloadId===99?{...job,downloadState:'complete'}:job)});await panel.updateComplete;
  assert(root.querySelector('#file-download-activity').textContent.includes('1 saved') && !root.querySelector('#file-download-activity .animate-spin'),'Saved files clear the spinner and retain their count');

  const csvFinished={...finished,id:'csv-run',jobs:finished.jobs.map(job=>({...job,fileRowCount:1})),settings:{...finished.settings,fileType:'csv'}};
  panel.receiveRun(csvFinished); await panel.updateComplete;
  assert(root.querySelector('#completeness-summary').textContent.includes('CSV file rows:'),'CSV exports show file verification');
  assert(root.querySelector('#completeness-summary').textContent.includes('CSV files contain 3 data rows'),'Warn when verified file counts differ from the source list');
  let combined;
  panel.addEventListener('sn-export-download-combined',event=>{combined=event.detail});
  root.querySelector('#download-combined').click(); await panel.updateComplete;
  assert(combined.runId==='csv-run' && combined.filenamePrefix==='incident','Combined CSV uses the download name');
  assert(!root.querySelector('#download-all').disabled && root.querySelector('#download-combined').disabled,'Combining allows separate downloads and prevents duplicate merges');
  assert(root.querySelector('footer #csv-combine-status .animate-spin'),'Combining shows a footer spinner');
  panel.combinedRequested(3); await panel.updateComplete;
  assert(!panel.downloading && root.textContent.includes('Combined CSV download requested'),'Combined action clears its busy state');

  panel.receiveRun({...csvFinished,revision:8,jobs:csvFinished.jobs.map((job,index)=>({...job,...(index===0?{downloadError:'denied'}:index===1?{downloadId:2,downloadState:'complete'}:{})}))});await panel.updateComplete;
  assert(root.querySelector('#download-counts').textContent.includes('1 failed'),'Download summary exposes failed requests');
  let retryRequested;
  panel.addEventListener('sn-export-retry-downloads',event=>{retryRequested=event.detail});
  root.querySelector('#retry-downloads').click();await panel.updateComplete;
  assert(retryRequested.runId==='csv-run' && panel.downloading,'Retry uses the tracked run without starting exports');
  panel.downloadsRequested(1,0);await panel.updateComplete;
  panel.receiveContext(context); panel.receiveRun(null); await panel.updateComplete;
  assert(root.querySelector('#display-values').checked && root.querySelector('#fields').value === '', 'Reset new-run options');
  input('#query','priority=1'); await panel.updateComplete;
  assert(!root.querySelector('#review-export').disabled,'A different export query does not require Apply');
  root.querySelector('#review-export').click();await panel.updateComplete;
  assert(root.querySelector('#query-mismatch-warning') && !root.querySelector('#confirm-export').disabled,'Review warns but allows the different export query');
  panel.confirmation=null;await panel.updateComplete;
  let applied; panel.addEventListener('sn-export-apply',event=>{applied=event.detail.query});
  root.querySelector('.apply').click(); await panel.updateComplete;
  assert(applied === 'priority=1' && panel.applying, 'Apply encoded query');
  panel.applyFailed('Refresh failed'); await panel.updateComplete;
  assert(!panel.applying && root.textContent.includes('Refresh failed'), 'Show Apply failure');
  panel.receiveContext(context);panel.receiveRun(null);await panel.updateComplete;
  input('#fields','number');input('#file-type','json','change');input('#concurrency','2');await panel.updateComplete;
  root.querySelector('#review-export').click();await panel.updateComplete;
  panel.listLoading();await panel.updateComplete;
  assert(!root.querySelector('#confirm-export') && root.querySelector('#review-export').disabled,'List navigation invalidates review and old count');
  panel.syncListContext({...context,filter:'state=2',rowCount:17001});await panel.updateComplete;
  assert(root.querySelector('#query').value===context.filter && panel.context.rowCount===context.rowCount,'List reload retains the panel filter/count snapshot');
  assert(root.querySelector('#refresh-from-list'),'Different list filter offers an explicit refresh');
  let refreshRequested;panel.addEventListener('sn-export-refresh-list',event=>{refreshRequested=event.detail});
  root.querySelector('#refresh-from-list').click();await panel.updateComplete;
  assert(refreshRequested.frameId===context.frameId,'Refresh reads the original list frame');
  panel.importListContext({...context,filter:'state=2',rowCount:17001});await panel.updateComplete;
  assert(root.querySelector('#query').value==='state=2' && panel.context.rowCount===17001,'Explicit refresh imports the list filter and its count');
  assert(root.querySelector('#fields').value==='number' && root.querySelector('#file-type').value==='json' && root.querySelector('#concurrency').value==='2','List sync preserves configured fields, format, and concurrency');
  panel.receiveContext({...context,rowCount:0}); panel.receiveRun(null); await panel.updateComplete;
  assert(root.querySelector('#review-export').disabled && root.textContent.includes('No matching rows'), 'Zero rows cannot launch');
  panel.receiveContext(null); panel.receiveRun(null); await panel.updateComplete;
  assert(root.textContent.includes('Unable to read list details'), 'Missing-list state');
  root.querySelector('#refresh-from-page').click();await panel.updateComplete;
  assert(refreshRequested.frameId===undefined && panel.listRefreshing,'Missing-list refresh rescans every allowed frame');
  panel.operationFailed('No list yet');await panel.updateComplete;
  assert(!root.querySelector('#refresh-from-page').disabled,'Refresh can be retried if no list is ready');
  root.querySelector('#refresh-from-page').click();
  panel.importListContext(context);await panel.updateComplete;
  assert(root.querySelector('#query').value===context.filter && panel.context.rowCount===context.rowCount,'Refresh fills in the newly available list without reopening');
  assert(panel.filenamePrefix==='incident','First detected list initializes the filename prefix');
  let historyRefreshes=0;panel.addEventListener('sn-export-history',()=>historyRefreshes++);
  root.querySelector('#tab-history').click();await panel.updateComplete;
  assert(historyRefreshes===1 && panel.historyBusy && root.querySelector('#export-body').hidden,'History tab reads current session records');
  const history={origin:'https://example.service-now.com',userId:'a'.repeat(32),records:[
    {sysId:'b'.repeat(32),jobId:'c'.repeat(32),state:'complete',current:100,max:100,message:'',createdOn:'2026-10-14 23:09:14',updatedOn:''},
    {sysId:'d'.repeat(32),jobId:'e'.repeat(32),state:'complete',current:50,max:50,message:'',createdOn:'2026-10-14 23:10:14',updatedOn:''}],
    attachments:[{sysId:'f'.repeat(32),pollId:'b'.repeat(32),fileName:'export.csv',contentType:'text/csv'},
      {sysId:'1'.repeat(32),pollId:'d'.repeat(32),fileName:'other.csv',contentType:'text/csv'}],
    batches:[{id:'batch-1',origin:'https://example.service-now.com',userId:'a'.repeat(32),createdAt:Date.now(),updatedAt:Date.now(),settings:{...run.settings,fileType:'csv'},plannedJobs:1,jobs:[{number:1,jobId:'c'.repeat(32)}]}]};
  panel.receiveHistory(history);await panel.updateComplete;
  assert(root.querySelector('#history-body').textContent.includes('Other user exports'),'Ungrouped jobs have their own heading');
  assert(root.querySelector('[data-history-batch="batch-1"]'),'Saved jobs are grouped by batch');
  let historyRemoval;panel.addEventListener('sn-export-history-remove',event=>{historyRemoval=event.detail});
  root.querySelector('#clear-history').click();await panel.updateComplete;
  assert(historyRemoval.all===true && panel.historyActionBusy,'Clear history dispatches local cleanup and disables actions');
  panel.historyActionFinished('Cleared');await panel.updateComplete;
  [...root.querySelectorAll('#history-body button')].find(button=>button.textContent==='Remove batch').click();await panel.updateComplete;
  assert(historyRemoval.batchId==='batch-1','Remove batch targets its saved mapping');
  panel.historyActionFinished('Removed');await panel.updateComplete;
  [...root.querySelectorAll('#history-body button')].find(button=>button.textContent==='Remove').click();await panel.updateComplete;
  assert(historyRemoval.pollId===history.records.find(record=>!history.batches[0].jobs.some(job=>job.jobId===record.jobId)).sysId,'Remove targets the ungrouped export');
  panel.historyActionFinished('Removed');await panel.updateComplete;
  const historyButtons=[...root.querySelectorAll('#history-body button')];
  let historyDownload;panel.addEventListener('sn-export-history-download',event=>{historyDownload=event.detail});
  historyButtons.find(button=>button.textContent==='Download').click();await panel.updateComplete;
  assert(historyDownload.attachmentId==='f'.repeat(32),'Download selects the linked attachment');
  assert(root.querySelector('#history-activity .animate-spin') && root.querySelector('#history-activity').textContent.includes('Requesting file download'),'History downloads show their processing state');
  panel.historyActionFinished('Requested');await panel.updateComplete;
  let historyCombined;panel.addEventListener('sn-export-history-combine',event=>{historyCombined=event.detail});
  [...root.querySelectorAll('#history-body button')].find(button=>button.textContent==='Download combined CSV').click();await panel.updateComplete;
  assert(historyCombined.batchId==='batch-1','Combine selects a recorded complete CSV batch');
  panel.historyActionFinished('Requested');await panel.updateComplete;
  let historyOpen;panel.addEventListener('sn-export-history-open-list',event=>{historyOpen=event.detail});
  [...root.querySelectorAll('#history-body button')].find(button=>button.textContent==='Open list with filter').click();await panel.updateComplete;
  assert(historyOpen.batchId==='batch-1','Navigation is a separate explicit action');
  panel.historyActionFinished('Opened');await panel.updateComplete;
  const oldSubmissions=submissions.length;
  [...root.querySelectorAll('#history-body button')].find(button=>button.textContent==='Rerun').click();await panel.updateComplete;
  assert(panel.activeTab==='export' && panel.query===history.batches[0].settings.query && !panel.confirmation && submissions.length===oldSubmissions,'Rerun restores saved settings without starting jobs');
  root.querySelector('[aria-label="Close export panel"]').click();
  assert(!panel.isConnected, 'Close panel');
  const handlers=[];
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:{runtime:{id:'test-extension',onMessage:{addListener:listener=>handlers.push(listener)},sendMessage:async message=>message.type==='SN_EXPORT_HISTORY'?{history}:message.type==='SN_EXPORT_HISTORY_CSV'?{text:'number,description\\r\\nHIS1,test\\r\\n'}:message.type==='SN_EXPORT_READ_CSV'?{text:'number,description\\r\\nINC'+message.jobId+',test\\r\\n'}:{run:null}}}});
  const query=document.querySelector.bind(document), create=document.createElement.bind(document);
  const wrap=element=>element && new Proxy(element,{get(target,key){
    if(['receiveContext','receiveRun','operationFailed'].includes(key))return undefined;
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  document.querySelector=function(selector){const element=query(selector);return selector==='[data-sn-export-panel]'?wrap(element):element};
  document.createElement=function(name,...args){
    if(name.includes('-'))throw new TypeError('Illegal constructor.');
    return create(name,...args);
  };
  installContent();installContent();
  assert(handlers.length===1,'Repeated injection must not duplicate the message listener');
  let opened;
  handlers[0]({type:'SN_EXPORT_OPEN',context},{id:'test-extension'},response=>{opened=response.opened});
  await new Promise(resolve=>setTimeout(resolve,0));
  const wrapped=document.querySelector('[data-sn-export-panel]');
  assert(wrapped.receiveContext===undefined,'Fixture hides custom methods through DOM wrappers');
  assert(opened && wrapped.shadowRoot.textContent.includes('incident'),'Opening succeeds with a retained class instance');
  handlers[0]({type:'SN_EXPORT_RUN',run:finished},{id:'test-extension'},()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(wrapped.shadowRoot.textContent.includes('3 of 3 jobs completed'),'Progress updates avoid DOM wrapper method lookups');
  const actualClick=HTMLAnchorElement.prototype.click;
  let combinedDownload;
  HTMLAnchorElement.prototype.click=function(){combinedDownload={url:this.href,filename:this.download};};
  handlers[0]({type:'SN_EXPORT_RUN',run:csvFinished},{id:'test-extension'},()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  wrapped.shadowRoot.querySelector('#download-combined').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(combinedDownload?.filename==='incident.csv','Merged filename uses one CSV extension');
  const combinedText=await (await fetch(combinedDownload.url)).text();
  assert(combinedText==='number,description\\r\\nINC1,test\\r\\nINC2,test\\r\\nINC3,test\\r\\n','Content handler merges all chunks with one header');
  const downloadTest=document.createElement('a'); downloadTest.id='verify-combined-file';
  downloadTest.href=combinedDownload.url;downloadTest.download=combinedDownload.filename;document.body.append(downloadTest);
  const progressiveRun={...csvFinished,id:'progressive-run',status:'running',revision:1,
    jobs:csvFinished.jobs.map((job,index)=>({...job,status:index===0?'running':'completed',attachmentId:index===0?undefined:job.attachmentId,fileRowCount:undefined}))};
  combinedDownload=undefined;
  handlers[0]({type:'SN_EXPORT_RUN',run:progressiveRun},{id:'test-extension'},()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(wrapped.shadowRoot.querySelector('#download-combined').textContent==='Start combining CSV','Two completed chunks enable opt-in progressive combining');
  wrapped.shadowRoot.querySelector('#download-combined').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert(!combinedDownload,'Progressive combining does not download before batch finishes');
  assert(wrapped.shadowRoot.querySelector('#completeness-summary').textContent.includes('2 data rows across 2/3 files'),'Live CSV counts update before final chunk');
  assert(!wrapped.shadowRoot.querySelector('[data-download-job="2"]').disabled,'Individual file downloads remain available during combining');
  handlers[0]({type:'SN_EXPORT_RUN',run:{...progressiveRun,status:'completed',revision:2,jobs:csvFinished.jobs.map(job=>({...job,fileRowCount:undefined}))}},{id:'test-extension'},()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(combinedDownload?.filename==='incident.csv','Last completion automatically downloads combined CSV');
  assert((await (await fetch(combinedDownload.url)).text())===combinedText,'Out-of-order completions retain chunk order and one header');
  wrapped.shadowRoot.querySelector('#tab-history').click();await new Promise(resolve=>setTimeout(resolve,0));
  assert(wrapped.shadowRoot.querySelector('#history-body').textContent.includes('Other user exports'),'Content handler reads history into its tab');
  [...wrapped.shadowRoot.querySelectorAll('#history-body button')].find(button=>button.textContent==='Download combined CSV').click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert((await (await fetch(combinedDownload.url)).text())==='number,description\\r\\nHIS1,test\\r\\n','History combine downloads linked CSV content with one header');
  assert(wrapped.shadowRoot.querySelector('#history-body').textContent.includes('Row count differs'),'History CSV counts are compared with the stored batch count');
  URL.revokeObjectURL(combinedDownload.url);
  HTMLAnchorElement.prototype.click=actualClick;
  wrapped.shadowRoot.querySelector('[aria-label="Close export panel"]').click();
  handlers[0]({type:'SN_EXPORT_OPEN',context},{id:'test-extension'},response=>{opened=response.opened});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(opened && document.querySelector('[data-sn-export-panel]').shadowRoot.textContent.includes('incident'),'Close and reopen construct a fresh owned instance');
  document.querySelector=query;document.createElement=create;
  handlers[0]({type:'SN_EXPORT_LIST_CONTEXT',context:{...context,frameId:99,filter:'ignore=true'}},{id:'test-extension'},()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(document.querySelector('[data-sn-export-panel]').shadowRoot.querySelector('#query').value===context.filter,'Ignore unrelated frames');
  handlers[0]({type:'SN_EXPORT_LIST_LOADING',frameId:7},{id:'test-extension'},()=>{});
  handlers[0]({type:'SN_EXPORT_LIST_CONTEXT',context:{...context,filter:'state=3'}},{id:'test-extension'},()=>{});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(document.querySelector('[data-sn-export-panel]').shadowRoot.querySelector('#query').value===context.filter,'Live context messages do not overwrite the panel query');
  const finalRoot=document.querySelector('[data-sn-export-panel]').shadowRoot;
  const section=finalRoot.querySelector('section'), header=finalRoot.querySelector('header'), footer=finalRoot.querySelector('footer');
  const body=finalRoot.querySelector('#export-body');
  assert(Math.round(section.getBoundingClientRect().width)===640,'Panel width is 640px');
  assert(getComputedStyle(body).overflowY==='auto' && body.scrollHeight>body.clientHeight,'Body scrolls');
  const headerY=header.getBoundingClientRect().top,footerY=footer.getBoundingClientRect().top;
  body.scrollTop=body.scrollHeight;
  assert(header.getBoundingClientRect().top===headerY && footer.getBoundingClientRect().top===footerY,'Header and footer remain fixed while content scrolls');
  body.scrollTop=0;
  document.body.dataset.result='passed';
} catch(error) { document.body.dataset.result='failed'; document.body.textContent=error.stack || String(error); }
`;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'check.js'].includes(name)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(await readFile(path.join(directory, name)));
  } catch { response.writeHead(500).end(); }
});

try {
  await build({
    configFile: false, logLevel: 'error',
    plugins: [panelStyles(), {
      name: 'panel-check-entry',
      resolveId(id) { if (id === 'panel-check') return '\0panel-check'; },
      load(id) { if (id === '\0panel-check') return entry; },
    }],
    build: { outDir: directory, emptyOutDir: false, target: 'esnext', rollupOptions: {
      input: 'panel-check', output: { entryFileNames: 'check.js', format: 'es' },
    } },
  });
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><body><script type="module" src="./check.js"></script></body></html>');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = spawn(process.env.CHROMIUM_BIN || 'chromium', [
    '--headless', '--window-size=1280,900', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-breakpad',
    `--user-data-dir=${path.join(directory, 'profile')}`, '--remote-debugging-port=0',
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, XDG_CACHE_HOME: directory, XDG_CONFIG_HOME: directory, DCONF_PROFILE: '/dev/null' },
  });
  let stderr = '';
  browser.stderr.on('data', chunk => { stderr += chunk; });
  const processExit = new Promise(resolve => browser.once('exit', resolve));
  let socket;
  try {
    const deadline = Date.now() + 15000;
    let debugPort;
    while (Date.now() < deadline && !debugPort) {
      try { debugPort = Number((await readFile(path.join(directory, 'profile/DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(debugPort, `Chromium debugger did not start: ${stderr.slice(-2000)}`);
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = pages.find(page => page.type === 'page');
    assert.ok(page?.webSocketDebuggerUrl, 'Chromium must expose a page target');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Browser check timed out')); }, 10000);
      const receive = event => {
        const data = JSON.parse(event.data);
        if (data.id !== id) return;
        clearTimeout(timeout);
        socket.removeEventListener('message', receive);
        if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
      };
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ id, method, params }));
    });
    await request('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    let outcome;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const result = await request('Runtime.evaluate', { expression: 'JSON.stringify({ result: document.body?.dataset.result, text: document.body?.textContent })', returnByValue: true });
        outcome = JSON.parse(result.result.value);
        if (outcome.result) break;
      } catch { /* The navigation can briefly replace the execution context. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (outcome?.result === 'passed') {
      await request('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:directory});
      await request('Runtime.evaluate',{expression:"document.querySelector('#verify-combined-file').click()"});
      let downloaded;
      for(let attempt=0;attempt<50;attempt++) {
        try { downloaded=await readFile(path.join(directory,'incident.csv'),'utf8');break; }
        catch { await new Promise(resolve=>setTimeout(resolve,100)); }
      }
      assert.equal(downloaded,'number,description\r\nINC1,test\r\nINC2,test\r\nINC3,test\r\n','Browser saves the combined Blob with the correct filename and one header');
    }
    if (process.env.PANEL_SCREENSHOT && outcome?.result === 'passed') {
      const screenshot=await request('Page.captureScreenshot',{format:'png'});
      await writeFile(process.env.PANEL_SCREENSHOT,Buffer.from(screenshot.data,'base64'));
    }
    assert.equal(outcome?.result, 'passed', `Browser panel checks failed: ${outcome?.text || stderr.slice(-2000)}`);
  } finally {
    socket?.close();
    browser.kill('SIGTERM');
    await processExit;
  }
  console.log('Lit panel browser checks passed: real-export controls, explicit confirmation, restored progress, downloads, Apply, and empty/missing lists');
} finally {
  await new Promise(resolve => server.close(resolve));
  // Chrome child processes can finish flushing the profile after its parent exits.
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
