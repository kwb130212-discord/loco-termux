from __future__ import annotations
from dataclasses import asdict, dataclass
from collections import Counter, deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Condition, RLock, Thread
from typing import Any, Iterable
import json, os, tempfile, time

@dataclass(slots=True)
class MemberEvent:
    room_id: str
    user_id: str
    nickname: str
    event: str
    at: str
    count: int = 0
    message_id: str | None = None

@dataclass(slots=True)
class PendingLeave:
    room_id: str
    user_id: str
    nickname: str
    left_at: str
    message_id: str | None = None

@dataclass(slots=True)
class SessionDiagnostic:
    user_id: str
    session_id: str | None
    observed_at: str
    status: str
    error_code: str | None = None
    detail: str | None = None

class LocoAnalyzer:
    """Fast durable analyzer for authenticated, observable LOCO events."""
    VALID_EVENTS=frozenset(("JOIN","LEAVE","READ","KICK")); VERSION=7
    def __init__(self,data_file="loco_analyzer.json",max_events=5000,max_reads=5000,max_diagnostics=1000,max_messages=5000,save_delay=.2,save_every=0):
        self.data_file=Path(data_file).expanduser(); self.max_events=max(1,int(max_events)); self.max_reads=max(1,int(max_reads)); self.max_diagnostics=max(1,int(max_diagnostics)); self.max_messages=max(1,int(max_messages)); self.save_delay=max(0.,float(save_delay)); self.save_every=max(0,int(save_every))
        self._lock=RLock(); self._condition=Condition(self._lock); self._dirty=False; self._stopping=False; self._changes=0
        self.events=deque(maxlen=self.max_events); self.pending_leaves={}; self.reads={}; self._read_order=deque(maxlen=self.max_reads); self.join_counts={}; self.online={}; self.messages={}; self._message_order=deque(maxlen=self.max_messages); self._room_stats={}; self.session_diagnostics=deque(maxlen=self.max_diagnostics)
        self._load(); self._worker=Thread(target=self._persistence_worker,name="loco-persist",daemon=True); self._worker.start()
    @staticmethod
    def _now(): return datetime.now(timezone.utc).isoformat(timespec="seconds")
    @staticmethod
    def _safe_user(user):
        if isinstance(user,dict): uid=user.get("user_id",user.get("userId",user.get("id",user.get("uid")))); name=user.get("nickname",user.get("nickName",user.get("name","알 수 없음")))
        else: uid=next((getattr(user,k,None) for k in ("user_id","userId","id","uid") if getattr(user,k,None) is not None),None); name=next((getattr(user,k,None) for k in ("nickname","nickName","name") if getattr(user,k,None)),"알 수 없음")
        return str(uid or name).strip(),str(name or "알 수 없음").strip()
    @staticmethod
    def _key(room_id,user_id): return f"{room_id}\x1f{user_id}"
    @staticmethod
    def _iso(v):
        if v is None:return LocoAnalyzer._now()
        if isinstance(v,(int,float)):return datetime.fromtimestamp(float(v),timezone.utc).isoformat(timespec="seconds")
        return str(v).strip() or LocoAnalyzer._now()
    @classmethod
    def _event(cls,raw):
        try:
            e=str(raw.get("event","")).upper()
            if e not in cls.VALID_EVENTS:return None
            return MemberEvent(str(raw.get("room_id","")),str(raw.get("user_id","")),str(raw.get("nickname","알 수 없음")),e,cls._iso(raw.get("at")),int(raw.get("count",0) or 0),raw.get("message_id"))
        except (TypeError,ValueError,AttributeError):return None
    def _load(self):
        try:p=json.loads(self.data_file.read_text(encoding="utf-8"))
        except (OSError,ValueError,TypeError):return
        if not isinstance(p,dict):return
        with self._lock:
            for x in p.get("events",[]):
                if isinstance(x,dict):
                    e=self._event(x)
                    if e:self._append_event(e,False)
            for k,v in (p.get("pending_leaves",{}) or {}).items():
                if isinstance(v,dict):
                    try:self.pending_leaves[str(k)]=PendingLeave(str(v.get("room_id","")),str(v.get("user_id","")),str(v.get("nickname","알 수 없음")),self._iso(v.get("left_at")),v.get("message_id"))
                    except (TypeError,ValueError):pass
            rr=p.get("reads",{})
            if isinstance(rr,dict):
                for mid,users in list(rr.items())[-self.max_reads:]:
                    if isinstance(users,dict):self.reads[str(mid)]={str(k):str(v) for k,v in users.items()}
            self._read_order.extend(self.reads)
            jc=p.get("join_counts",{}); self.join_counts={str(k):max(0,int(v)) for k,v in jc.items()} if isinstance(jc,dict) else {}
            online=p.get("online",{}); self.online={str(k):{"user_id":str(v.get("user_id","")),"nickname":str(v.get("nickname",""))} for k,v in online.items() if isinstance(v,dict)} if isinstance(online,dict) else {}
            mm=p.get("messages",{}); self.messages={str(k):v for k,v in list(mm.items())[-self.max_messages:] if isinstance(v,dict)} if isinstance(mm,dict) else {}; self._message_order.extend(self.messages)
            for x in p.get("session_diagnostics",[]) [-self.max_diagnostics:]:
                if isinstance(x,dict):
                    try:self.session_diagnostics.append(SessionDiagnostic(str(x.get("user_id","")),x.get("session_id"),self._iso(x.get("observed_at")),str(x.get("status","")),x.get("error_code"),x.get("detail")))
                    except (TypeError,ValueError):pass
    def _append_event(self,e,persist=True):
        self.events.append(e); s=self._room_stats.setdefault(e.room_id,Counter()); s["events"]+=1; s[e.event.lower()]+=1
        if persist:self._save()
    def _save_now(self):
        p={"version":self.VERSION,"updated_at":self._now(),"events":[asdict(x) for x in self.events],"pending_leaves":{k:asdict(v) for k,v in self.pending_leaves.items()},"reads":self.reads,"join_counts":self.join_counts,"online":self.online,"messages":self.messages,"session_diagnostics":[asdict(x) for x in self.session_diagnostics]}
        tmp=None
        try:
            self.data_file.parent.mkdir(parents=True,exist_ok=True); fd,tmp=tempfile.mkstemp(prefix=f".{self.data_file.name}.",dir=str(self.data_file.parent))
            with os.fdopen(fd,"w",encoding="utf-8") as f:json.dump(p,f,ensure_ascii=False,separators=(",",":"));f.flush();os.fsync(f.fileno())
            os.replace(tmp,self.data_file)
            with self._lock:self._dirty=False
        except OSError as e:print(f"[Analyzer] save failed: {e}")
        finally:
            if tmp:
                try:os.unlink(tmp)
                except OSError:pass
    def _persistence_worker(self):
        while True:
            with self._condition:
                while not self._dirty and not self._stopping:self._condition.wait()
                if self._stopping and not self._dirty:return
            if self.save_delay:time.sleep(self.save_delay)
            self._save_now()
    def _save(self,force=True):
        with self._condition:self._dirty=True;self._changes+=1;self._condition.notify()
    def flush(self):
        with self._lock:
            if self._dirty:self._save_now()
    def close(self):
        self.flush()
        with self._condition:self._stopping=True;self._condition.notify_all()
        if self._worker.is_alive():self._worker.join(timeout=max(1.,self.save_delay+1.))
    def authenticated_user(self,room_id,user_id,nickname,session_id):
        if not str(user_id) or not str(session_id):raise ValueError("authenticated_user requires user_id and session_id")
        count=self.user_joined(room_id,{"user_id":user_id,"nickname":nickname});self.record_session_diagnostic(user_id,session_id,"AUTHENTICATED",detail="Verified by analyzer auth adapter")
        return {"ok":True,"authenticated":True,"user_id":str(user_id),"nickname":str(nickname),"session_id":str(session_id),"join_count":count}
    def user_joined(self,room_id,user,message_id=None):
        rid=str(room_id);uid,name=self._safe_user(user);key=self._key(rid,uid)
        with self._lock:
            count=self.join_counts.get(key,0)+1;self.join_counts[key]=count;self.online[key]={"user_id":uid,"nickname":name};self.pending_leaves.pop(key,None);self._append_event(MemberEvent(rid,uid,name,"JOIN",self._now(),count,message_id),False)
        self._save();return count
    def user_left(self,room_id,user,message_id=None):
        rid=str(room_id);uid,name=self._safe_user(user);key=self._key(rid,uid);now=self._now()
        with self._lock:self._append_event(MemberEvent(rid,uid,name,"LEAVE",now,self.join_counts.get(key,0),message_id),False);self.pending_leaves[key]=PendingLeave(rid,uid,name,now,message_id);self.online.pop(key,None)
        self._save();return self.leave_message(name,now)
    def user_kicked(self,room_id,user,message_id=None):
        rid=str(room_id);uid,name=self._safe_user(user);key=self._key(rid,uid)
        with self._lock:self._append_event(MemberEvent(rid,uid,name,"KICK",self._now(),self.join_counts.get(key,0),message_id),False);self.pending_leaves.pop(key,None);self.online.pop(key,None)
        self._save()
    def record_read(self,message_id,user):
        mid=str(message_id).strip();uid,name=self._safe_user(user)
        if not mid or not uid:return
        with self._lock:
            if mid not in self.reads:self._read_order.append(mid);self.reads[mid]={}
            self.reads[mid][uid]=name
            while len(self._read_order)>self.max_reads:self.reads.pop(self._read_order.popleft(),None)
        self._save()
    def record_message(self,room_id,message_id,user,text="",*,at=None,readers:Iterable[object]|None=None,reader_count=None,raw=None):
        rid,mid=str(room_id).strip(),str(message_id).strip();uid,name=self._safe_user(user)
        if not rid or not mid:raise ValueError("room_id and message_id are required")
        item={"message_id":mid,"room_id":rid,"user_id":uid,"nickname":name,"text":str(text),"at":self._iso(at),"reader_count":None if reader_count is None else max(0,int(reader_count))}
        with self._lock:
            if mid not in self.messages:self._message_order.append(mid)
            self.messages[mid]=item
            if readers is not None:
                for x in readers:self.record_read(mid,x)
            if isinstance(raw,dict):item["raw_keys"]=list(raw)[:100]
            while len(self._message_order)>self.max_messages:self.messages.pop(self._message_order.popleft(),None)
        self._save();return dict(item)
    def record_session_diagnostic(self,user_id,session_id,status,error_code=None,detail=None):
        with self._lock:self.session_diagnostics.append(SessionDiagnostic(str(user_id),str(session_id) if session_id else None,self._now(),str(status),str(error_code) if error_code else None,str(detail) if detail else None))
        self._save()
    def diagnose_999(self,user_id):
        uid=str(user_id)
        with self._lock:last=next((x for x in reversed(self.session_diagnostics) if x.user_id==uid),None);n=sum(x.user_id==uid for x in self.session_diagnostics)
        return {"user_id":uid,"observations":n,"last_status":last.status if last else None,"last_error_code":last.error_code if last else None,"last_session_id":last.session_id if last else None,"recommendation":"Use the real OAuth/server response for diagnosis; authentication failures are not converted to success."}
    def leave_message(self,nickname,left_at):
        try:t=datetime.fromisoformat(str(left_at).replace("Z","+00:00")).astimezone().strftime("%H시 %M분")
        except ValueError:t=str(left_at)
        return f"{nickname}님이 나가셨습니다.\n\n[전체보기]\n\n{nickname} 님이 {t}에 나가셨습니다.\n나간사람을 내보내실려면 이 메시지에 답장으로 kick이라고 보내주세요.\n[관리자만 가능합니다]"
    def get_leave_detail(self,user_id,room_id=None):
        uid=str(user_id)
        with self._lock:return self.pending_leaves.get(self._key(str(room_id),uid)) if room_id is not None else next((x for x in reversed(tuple(self.pending_leaves.values())) if x.user_id==uid),None)
    def departed(self,room_id=None):
        rid=str(room_id) if room_id is not None else None
        with self._lock:rows=[asdict(x) for x in self.pending_leaves.values() if rid is None or x.room_id==rid]
        return sorted(rows,key=lambda x:x["left_at"],reverse=True)
    def online_members(self,room_id):
        p=str(room_id)+"\x1f"
        with self._lock:return [dict(v) for k,v in self.online.items() if str(k).startswith(p)]
    def get_readers(self,message_id):
        with self._lock:return [{"user_id":k,"nickname":v} for k,v in self.reads.get(str(message_id),{}).items()]
    def events_for_room(self,room_id,event=None,limit=100):
        rid,kind=str(room_id),str(event or "").upper();limit=max(1,min(1000,int(limit)))
        with self._lock:r=[asdict(x) for x in self.events if x.room_id==rid and (not kind or x.event==kind)]
        return r[-limit:][::-1]
    def chat_rank(self,room_id,limit=20):
        rid=str(room_id);c=Counter();names={}
        with self._lock:
            for x in self.messages.values():
                if str(x.get("room_id"))==rid:c[str(x.get("user_id",""))]+=1;names[str(x.get("user_id",""))]=str(x.get("nickname",""))
        return [{"rank":i,"user_id":u,"nickname":names.get(u,""),"messages":n} for i,(u,n) in enumerate(c.most_common(max(1,min(100,int(limit)))),1)]
    def stats(self,room_id=None):
        if room_id is not None:
            rid=str(room_id);s=self._room_stats.get(rid,{})
            with self._lock:msgs=sum(str(x.get("room_id"))==rid for x in self.messages.values())
            return {"room_id":rid,"events":int(s.get("events",0)),"joins":int(s.get("join",0)),"leaves":int(s.get("leave",0)),"kicks":int(s.get("kick",0)),"online":len(self.online_members(rid)),"messages":msgs}
        with self._lock:return {"events":len(self.events),"joins":sum(x.event=="JOIN" for x in self.events),"leaves":sum(x.event=="LEAVE" for x in self.events),"kicks":sum(x.event=="KICK" for x in self.events),"online":len(self.online),"messages":len(self.messages),"reads":len(self.reads),"diagnostics":len(self.session_diagnostics)}
    def snapshot(self,room_id=None):
        return {"version":self.VERSION,"generated_at":self._now(),"stats":self.stats(room_id),"online":self.online_members(room_id) if room_id is not None else list(self.online.values()),"events":self.events_for_room(room_id,limit=100) if room_id is not None else [asdict(x) for x in list(self.events)[-100:]][::-1],"departed":self.departed(room_id)[:100]}
    def is_admin(self,actor_user_id,admins):return str(actor_user_id) in {str(x) for x in admins}
    def kick_request(self,actor_user_id,target_user_id,admins,room_id=None):
        actor,target=str(actor_user_id),str(target_user_id)
        if not self.is_admin(actor,admins):return {"ok":False,"allowed":False,"reason":"admin_required"}
        if not target:return {"ok":False,"allowed":True,"reason":"target_required"}
        if room_id is not None and self._key(str(room_id),target) not in self.online:return {"ok":False,"allowed":True,"reason":"target_not_online"}
        return {"ok":True,"allowed":True,"action":"KICK","room_id":str(room_id) if room_id is not None else None,"target_user_id":target}
    def health(self):
        with self._lock:return {"ok":True,"version":self.VERSION,"file":str(self.data_file),"events":len(self.events),"messages":len(self.messages),"online":len(self.online),"reads":len(self.reads),"dirty":self._dirty,"worker_alive":self._worker.is_alive()}
    def __enter__(self):return self
    def __exit__(self,*_):self.close()

__all__=["LocoAnalyzer","MemberEvent","PendingLeave","SessionDiagnostic"]
