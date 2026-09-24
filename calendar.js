let calendarCursor=new Date();calendarCursor.setDate(1);
function calendarDateKey(year,month,day){return String(year).padStart(4,"0")+"-"+String(month+1).padStart(2,"0")+"-"+String(day).padStart(2,"0")}
function calendarLocalDate(value){if(!value)return null;const parts=String(value).split("-").map(Number);if(parts.length!==3||parts.some(n=>!Number.isFinite(n)))return null;return new Date(parts[0],parts[1]-1,parts[2])}
function calendarHumanDate(value){const d=calendarLocalDate(value);return d?d.toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"}):"—"}
function calendarEvents(){return data.filter(x=>isMediaServiceCategory(x.category)&&String(x.eventDate||"").trim()).sort((a,b)=>String(a.eventDate).localeCompare(String(b.eventDate))||String(a.no||"").localeCompare(String(b.no||"")))}
function calendarPrevMonth(){calendarCursor.setMonth(calendarCursor.getMonth()-1);renderCalendar()}
function calendarNextMonth(){calendarCursor.setMonth(calendarCursor.getMonth()+1);renderCalendar()}
function calendarToday(){const now=new Date();calendarCursor=new Date(now.getFullYear(),now.getMonth(),1);renderCalendar()}
function calendarStatusPill(x){const info=invoiceStatusInfo(x);return '<span class="status-pill '+info.cls+'">'+esc(info.status)+'</span>'}
function renderCalendar(){
  const grid=$("calendarGrid"),title=$("calendarMonthTitle"),list=$("calendarEventList");if(!grid||!title||!list)return;
  const year=calendarCursor.getFullYear(),month=calendarCursor.getMonth();title.textContent=calendarCursor.toLocaleDateString(undefined,{month:"long",year:"numeric"});
  const events=calendarEvents(),byDate={};events.forEach(x=>{const k=String(x.eventDate);(byDate[k]||(byDate[k]=[])).push(x)});
  const first=new Date(year,month,1),startOffset=first.getDay(),days=new Date(year,month+1,0).getDate(),prevDays=new Date(year,month,0).getDate(),today=new Date(),cells=[];
  ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(d=>cells.push('<div class="calendar-weekday">'+d+'</div>'));
  for(let i=0;i<42;i++){
    const dayNum=i-startOffset+1;let cellYear=year,cellMonth=month,day=dayNum,other=false;
    if(dayNum<1){cellMonth=month-1;if(cellMonth<0){cellMonth=11;cellYear=year-1}day=prevDays+dayNum;other=true}
    else if(dayNum>days){cellMonth=month+1;if(cellMonth>11){cellMonth=0;cellYear=year+1}day=dayNum-days;other=true}
    const key=calendarDateKey(cellYear,cellMonth,day),dayEvents=byDate[key]||[],isToday=key===calendarDateKey(today.getFullYear(),today.getMonth(),today.getDate());
    let html='<div class="calendar-day '+(other?'other-month ':'')+(isToday?'today':'')+'"><div class="calendar-day-number">'+day+'</div>';
    dayEvents.slice(0,3).forEach(x=>{html+='<button type="button" class="calendar-event" onclick="openCalendarInvoice(\''+esc(x.id)+'\')"><span class="event-no">'+esc(x.no||"Invoice")+' · '+esc(fmtMoney(x.total,x.cur))+'</span><span class="event-client">'+esc(x.client||"No client")+'</span><span class="event-cat">'+esc(x.category||"Media")+'</span></button>'});
    if(dayEvents.length>3)html+='<div class="calendar-more">+'+(dayEvents.length-3)+' more</div>';cells.push(html+'</div>');
  }
  grid.innerHTML=cells.join("");
  const monthEvents=events.filter(x=>{const d=calendarLocalDate(x.eventDate);return d&&d.getFullYear()===year&&d.getMonth()===month});
  list.innerHTML=monthEvents.length?monthEvents.map(x=>{const d=calendarLocalDate(x.eventDate),p=paymentTotals(x);return '<button type="button" class="calendar-list-row" style="width:100%;background:none;border:0;color:inherit;text-align:left;cursor:pointer" onclick="openCalendarInvoice(\''+esc(x.id)+'\')"><span class="calendar-list-date"><b>'+d.getDate()+'</b><small>'+d.toLocaleDateString(undefined,{month:"short"})+'</small></span><span class="calendar-list-main"><b>'+esc(x.no||"Invoice")+' · '+esc(x.client||"No client")+'</b><small>'+esc(x.category||"Media")+' · '+calendarStatusPill(x)+' · '+esc(calendarHumanDate(x.eventDate))+'</small></span><span class="calendar-list-right"><b>'+esc(fmtMoney(x.total,x.cur))+'</b><small>Balance '+esc(fmtMoney(p.balance,x.cur))+'</small></span></button>}).join(""):'<div style="color:#777;text-align:center;padding:20px">No media events scheduled for this month.</div>';
}
function closeCalendarModal(){const m=$("calendarModal");if(m){m.classList.remove("show");m.setAttribute("aria-hidden","true")}}
function openCalendarInvoice(id){
  const x=data.find(a=>a.id===id);if(!x)return;const modal=$("calendarModal"),body=$("calendarModalBody");if(!modal||!body)return;
  const p=paymentTotals(x),items=x.items||[];
  const rental=x.category==="Equipment Rentals"?'<div class="calendar-detail-card full"><span>Equipment Rental</span><b>'+esc(x.rentalStart||"—")+' → '+esc(x.rentalEnd||"—")+' · '+esc(x.rentalUnit||"Per Day")+' · '+esc(x.jobLocation||"—")+' · Ref '+esc(x.rentalRef||"—")+(x.deposit?' · Deposit '+esc(fmtMoney(x.deposit,x.cur)):"")+'</b></div>':"";
  const payments=Number(x.amountPaid||0)>0?'<div class="calendar-detail-card"><span>Payment Received</span><b>'+esc(fmtMoney(x.amountPaid,x.cur))+' · '+esc(x.paymentMethod||"Payment")+' · '+esc(x.paymentDate||"—")+' · Receipt '+esc(x.receiptNo||"—")+'</b></div><div class="calendar-detail-card"><span>Payment Reference</span><b>'+esc(x.transactionRef||"—")+' · Received by '+esc(x.receivedBy||"—")+'</b></div>':'<div class="calendar-detail-card full"><span>Payment Received</span><b>No payment recorded.</b></div>';
  const rows=items.map(i=>'<tr><td>'+esc(i.desc||"")+'</td><td>'+esc(money(i.rate))+'</td><td>'+esc(i.qty)+'</td><td>'+esc(money(i.qty*i.rate))+'</td></tr>').join("");
  $("calendarModalTitle").textContent=(x.no||"Invoice")+" · "+(x.client||"No client");$("calendarModalSubtitle").textContent=calendarHumanDate(x.eventDate);
  body.innerHTML='<div class="calendar-detail-grid">'+
    '<div class="calendar-detail-card"><span>Invoice Number</span><b>'+esc(x.no||"—")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Status</span><b>'+calendarStatusPill(x)+'</b></div>'+
    '<div class="calendar-detail-card"><span>Event Date</span><b>'+esc(calendarHumanDate(x.eventDate))+'</b></div>'+
    '<div class="calendar-detail-card"><span>Service Category</span><b>'+esc(x.category||"Media")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Brand / Model Group</span><b>'+esc(x.serviceBrand||"—")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Service / Equipment Item</span><b>'+esc(x.serviceItem||"—")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Client</span><b>'+esc(x.client||"—")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Client Contact</span><b>'+esc([x.clientPhone,x.clientEmail].filter(Boolean).join(" · ")||"—")+'</b></div>'+
    '<div class="calendar-detail-card full"><span>Client Address</span><b>'+esc(x.clientAddress||"—")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Invoice Date / Due</span><b>'+esc(x.date||"—")+' · Due '+esc(x.due||"On Receipt")+'</b></div>'+
    '<div class="calendar-detail-card"><span>Invoice Template</span><b>'+esc(String(x.template||"—"))+'</b></div>'+
    rental+payments+'</div>'+
  '<div class="calendar-detail-section-title">Invoice Items</div>'+
  '<table class="calendar-detail-table"><thead><tr><th>Description</th><th>Rate</th><th>Qty</th><th>Amount</th></tr></thead><tbody>'+(rows||'<tr><td colspan="4">No invoice items.</td></tr>')+'</tbody></table>'+
  '<div class="calendar-detail-section-title">Invoice Summary</div>'+
  '<div class="calendar-detail-grid"><div class="calendar-detail-card"><span>Subtotal</span><b>'+esc(fmtMoney(x.sub,x.cur))+'</b></div><div class="calendar-detail-card"><span>Discount</span><b>'+esc(fmtMoney(x.dis||x.discount||0,x.cur))+'</b></div><div class="calendar-detail-card"><span>Tax</span><b>'+esc(fmtMoney(x.tax,x.cur))+' · '+esc(x.taxRate)+'%</b></div><div class="calendar-detail-card"><span>Total / Balance</span><b>'+esc(fmtMoney(x.total,x.cur))+' · '+esc(fmtMoney(p.balance,x.cur))+'</b></div></div>'+
  '<div class="calendar-detail-section-title">Payment Information</div>'+
  '<div class="calendar-detail-card full"><b style="white-space:pre-wrap;font-weight:500">'+esc(x.payment||settings.defaultPay||"—")+'</b></div>'+
  '<div class="calendar-detail-section-title">Notes</div>'+
  '<div class="calendar-detail-card full"><b style="white-space:pre-wrap;font-weight:500">'+esc(x.notes||"—")+'</b></div>';
  const edit=$("calendarEditBtn"),print=$("calendarPrintBtn"),receipt=$("calendarReceiptBtn");
  if(edit)edit.onclick=function(){closeCalendarModal();loadInvoice(x.id)};if(print)print.onclick=function(){closeCalendarModal();loadInvoice(x.id);setTimeout(printInvoice,30)};
  if(receipt){const hasReceipt=Number(x.amountPaid||0)>0;receipt.style.display=hasReceipt?"inline-flex":"none";receipt.onclick=function(){closeCalendarModal();showReceipt(x.id)}}
  modal.classList.add("show");modal.setAttribute("aria-hidden","false");
}
window.renderCalendar=renderCalendar;
document.addEventListener("DOMContentLoaded",function(){if($("calendarGrid"))renderCalendar()});
