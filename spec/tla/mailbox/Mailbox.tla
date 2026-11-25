------------------------------ MODULE Mailbox ------------------------------
(***************************************************************************)
(* jabbu 메일박스의 dispatch·전달 경합 규칙. 덮는 소스는 covered.blobs에     *)
(* 적힌 파일이고, 규칙 표와 모델 가정은 README.md에 있다.                     *)
(*                                                                         *)
(* 한 origin의 일은 직렬 체인(OriginMailbox.#serial)에서 돈다. 이 모델은    *)
(* 체인 안의 await 지점(leafId·steer·prompt)을 별도 단계로 나눠, 그 사이에    *)
(* 턴 종료·재시작·동결·원장 쓰기 실패가 끼어드는 모든 순서를 TLC가 본다.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxSteers,          \* 한 턴에 끼워 넣을 수 있는 steer 수 (MAX_STEERS를 줄인 값)
    MaxRestarts,        \* 계획 재시작(apply drain) 횟수 상한
    MaxFailures,        \* delivery 확정 실패 상한 (MAX_DEFINITIVE_FAILURES를 줄인 값)
    LedgerFaults,       \* markDispatched가 던질 수 있다 (SQLITE_FULL/BUSY)
    \* 일부러 깬 규칙. broken-*.cfg가 하나씩 켠다.
    BugNoWriteAhead,    \* 전송 전 sending을 쓰지 않는다: 보낸 뒤 장부 기록 전에 끊기면 행이 pending으로 남는다
    BugTimeoutRetry,    \* child에 닿은 뒤 request_timeout으로 끝난 prompt를 새 driver로 한 번 더 보낸다
    BugReplayUncertain, \* 원장 쓰기 실패 행을 uncertain이 아닌 pending으로 남긴다
    BugStickySkip,      \* drain이 한 번 건너뛴 행(동결 보류·steer 상한)을 그 뒤에도 계속 건너뛴다
    BugAnyOrder,        \* drain이 첫 행이 아닌 아무 행이나 고른다
    BugNoStartGuard,    \* #startTurn이 child를 띄우는 동안에도 drain이 돈다
    BugRecoverConfirmed,\* 재시작 recover가 confirmed delivery도 pending으로 돌린다
    BugRateLimitCounts  \* rate_limited가 시도 횟수를 하나 올린다

Origins == {"o1", "o2"}
Rows == 1..3
\* owner: 오너의 일반 행, auto: 자율 행(동결이면 보류), waiter: peer 봇 행과 `/followup` 행
\* (둘 다 steer되지 않고 턴이 없을 때까지 기다린다: 모델에서 같은 동작이라 하나로 묶었다)
Kinds == {"owner", "auto", "waiter"}
\* 1행만 세 종류를 다 고른다. 2행 owner는 1행 뒤의 FIFO 짝·steer 대상, 3행 auto는 동결 보류와 steer 상한 이월을 맡는다.
KindsOf(r) == CASE r = 1 -> Kinds [] r = 2 -> {"owner"} [] OTHER -> {"auto"}
\* closed: answered와 failed_notified를 묶은 끝 상태 (규칙 5개는 둘을 구별하지 않는다)
\* sending: prompt·steer 직전의 write-ahead (mailbox-sending.ts beginSend). drain은 pending 행만 고른다.
RowStates == {"none", "pending", "sending", "dispatched", "closed", "uncertain"}
\* NoLostRow가 기다리는 끝: pending을 벗어난 상태
LeftPending == {"dispatched", "closed", "uncertain"}
Steps == {"", "steer", "steer_sent", "start", "start_sent"}
DeliveryStates == {"pending", "inflight", "confirmed", "failed_ambiguous", "expired"}

VARIABLES
    rstate,     \* inbound 행 상태 (none = 아직 안 들어옴)
    kind,       \* 행 종류 (들어올 때 정한다)
    sends,      \* 마지막 `/queue retry` 뒤로 행 글이 omp child에 닿은 횟수 (prompt + steer)
    retried,    \* 오너가 `/queue retry`를 이미 썼다 (행마다 한 번: 끝없는 재시도·원장 실패 고리를 막는다)
    fifoOut,    \* OriginFifo에서 빠지는 행: steer로 합쳐짐·동결 보류·steer 상한 이월·`/queue retry`
    step,       \* 진행 중인 #dispatch 단계
    turn,       \* origin별 턴: "none" | "running" | "final"(final 도착, #onFinal 대기)
    steers,     \* origin별 이번 턴 steer 수
    origin3,    \* 3행의 origin (Init에서 고르고 바뀌지 않는다)
    frozen, freezes, up, draining, restarts,
    fifoBroken, \* 관찰 변수: 앞선 일반 행이 pending인데 뒤 행이 새 턴으로 골라졌다
    dstate, attempts, defFails, confirms

rowVars == <<rstate, kind, sends, retried, fifoOut, step>>
originVars == <<turn, steers>>
sysVars == <<origin3, frozen, freezes, up, draining, restarts, fifoBroken>>
delVars == <<dstate, attempts, defFails, confirms>>
vars == <<rowVars, originVars, sysVars, delVars>>

\* 1·2행은 o1(순서·steer·동시 턴 경합)이고, 3행은 Init에서 o1(steer 상한 이월)이나 o2(다른 origin과의 끼어들기)를 고른다.
OriginOf == <<"o1", "o1", origin3>>

TypeOK ==
    /\ rstate \in [Rows -> RowStates]
    /\ kind \in [Rows -> Kinds]
    /\ sends \in [Rows -> Nat]
    /\ retried \in [Rows -> BOOLEAN] /\ fifoOut \in [Rows -> BOOLEAN]
    /\ step \in [Rows -> Steps]
    /\ turn \in [Origins -> {"none", "running", "final"}]
    /\ steers \in [Origins -> Nat]
    /\ origin3 \in Origins
    /\ dstate \in DeliveryStates

Init ==
    /\ rstate = [r \in Rows |-> "none"]
    /\ kind = [r \in Rows |-> "owner"]
    /\ sends = [r \in Rows |-> 0]
    /\ retried = [r \in Rows |-> FALSE]
    /\ fifoOut = [r \in Rows |-> FALSE]
    /\ step = [r \in Rows |-> ""]
    /\ turn = [o \in Origins |-> "none"]
    /\ steers = [o \in Origins |-> 0]
    /\ origin3 \in Origins
    /\ frozen = FALSE /\ freezes = 0 /\ up = TRUE /\ draining = FALSE /\ restarts = 0
    /\ fifoBroken = FALSE
    /\ dstate = "pending" /\ attempts = 0 /\ defFails = 0 /\ confirms = 0

Min(S) == CHOOSE x \in S : \A y \in S : x <= y
\* dispatched·closed 행은 다시 pending이 되지 않아 kind·sends·fifoOut을 어떤 규칙도 더 읽지 않는다.
\* 그 값을 한 모양으로 접어 같은 뜻의 상태를 한 번만 센다(sends 위반은 접기 전 상태에서 이미 검사된다).
Folded(r) ==
    /\ kind' = [kind EXCEPT ![r] = "owner"]
    /\ sends' = [sends EXCEPT ![r] = 0]
    /\ fifoOut' = [fifoOut EXCEPT ![r] = FALSE]
Pend(o) == {r \in Rows : rstate[r] = "pending" /\ OriginOf[r] = o}
\* 직렬 체인이 이 origin의 #dispatch 하나를 기다리는 중
Busy(o) == \E r \in Rows : OriginOf[r] = o /\ step[r] # ""
Starting(o) == {r \in Rows : OriginOf[r] = o /\ step[r] \in {"start", "start_sent"}}
\* 새 턴을 받은 순서대로 시작해야 하는 일반 행
Plain(r) == kind[r] \in {"owner", "auto"}
\* delivery가 처음 모양이다. inbound 행은 이때만 들어온다(DReady와 짝: 한 행동 열은 inbound나 delivery 한쪽만 움직인다).
DIdle == dstate = "pending" /\ attempts = 0 /\ confirms = 0

\* #drain이 행을 건너뛰는(continue) 이유들
HeldFrozen(r) == frozen /\ kind[r] = "auto"
WaitsIdle(r) == kind[r] = "waiter" /\ turn[OriginOf[r]] # "none"
CappedNow(r) == Plain(r) /\ turn[OriginOf[r]] # "none" /\ steers[OriginOf[r]] >= MaxSteers
Skips(r) == HeldFrozen(r) \/ WaitsIdle(r) \/ CappedNow(r) \/ (BugStickySkip /\ fifoOut[r])

----------------------------------------------------------------------------
(* 행 도착: OriginMailbox.#handle → store.recordInbound. drain 모드면 행은       *)
(* pending으로 남는다(drain_deferred) — DrainPass가 ~draining을 요구한다.       *)
Arrive(r) ==
    /\ up /\ rstate[r] = "none"
    /\ \A q \in 1..(r - 1) : rstate[q] # "none" \* 들어온 순서 = 행 번호
    /\ DIdle \* delivery 쪽과 곱해지지 않게 한다 (아래 DReady 설명)
    /\ \E k \in KindsOf(r) :
        /\ rstate' = [rstate EXCEPT ![r] = "pending"]
        /\ kind' = [kind EXCEPT ![r] = k]
    /\ UNCHANGED <<sends, retried, fifoOut, step, originVars, sysVars, delVars>>

(* #drain: pending 행을 들어온 순서로 보고, 건너뛸 행은 건너뛰고 첫 행을       *)
(* #dispatch한다. 턴이 돌면 steer, 없으면 새 턴(#startTurn). drain을 부르는 곳 *)
(* (도착·턴 끝·재시작 resumePending·정체 행 sweep·`/queue retry`)은 "고를 행이 *)
(* 있으면 언젠가 drain이 돈다"(약한 공정성)로 묶었다.                         *)
DrainPass(o) ==
    /\ up /\ ~draining
    \* final이 왔는데 #onFinal이 아직이면 첫 일반 행의 #dispatch가 false(break)로 끝난다:
    \* 아무것도 보내지 않으므로 drain은 #onFinal(Settle)이 다시 부를 때까지 없는 것과 같다.
    /\ turn[o] # "final"
    /\ BugNoStartGuard \/ ~Busy(o)
    /\ LET cands == {r \in Pend(o) : step[r] = "" /\ ~Skips(r)}
           skipped(q) == q \in Pend(o) /\ step[q] = "" /\ (HeldFrozen(q) \/ CappedNow(q))
       IN \E r \in cands :
             /\ BugAnyOrder \/ r = Min(cands)
             /\ fifoOut' = [q \in Rows |-> fifoOut[q] \/ (q < r /\ skipped(q))]
             /\ IF turn[o] = "none"
                   THEN /\ step' = [step EXCEPT ![r] = "start"]
                        /\ fifoBroken' = \/ fifoBroken
                                         \/ /\ Plain(r) /\ ~fifoOut[r]
                                            /\ \E q \in Pend(o) : q < r /\ Plain(q) /\ ~fifoOut'[q]
                   ELSE /\ step' = [step EXCEPT ![r] = "steer"]
                        /\ UNCHANGED fifoBroken
    /\ UNCHANGED <<rstate, kind, sends, retried, originVars, origin3, frozen, freezes, up, draining, restarts, delVars>>

(* 보내기 직전의 write-ahead(beginSend): 행을 sending으로 적고 보낸다. 적기와 *)
(* 보내기 사이에 끊기면 sends = 0인 sending 행이 남아 Boot에서 uncertain이 될  *)
(* 뿐이라(놓침, 두 번 실행 아님) 둘을 한 단계로 묶었다. 쓰기 실패는 보내지 않고 *)
(* pending에 둔다: DrainPass 전과 같은 상태라 모델에 넣지 않았다.              *)
SendState == IF BugNoWriteAhead THEN "pending" ELSE "sending"

(* steer 경로: leafId를 기다린 뒤 턴이 끝났으면(final) 아무것도 안 보내고     *)
(* pending으로 둔다. 아니면 write-ahead 뒤 steer를 보낸다. steer가 던지면     *)
(* child가 읽었을 수 있으므로 uncertain.                                      *)
SteerSend(r) ==
    /\ up /\ step[r] = "steer"
    /\ IF turn[OriginOf[r]] # "running"
          THEN /\ step' = [step EXCEPT ![r] = ""]
               /\ UNCHANGED <<rstate, sends, fifoOut>>
          ELSE \/ /\ sends' = [sends EXCEPT ![r] = @ + 1]
                  /\ rstate' = [rstate EXCEPT ![r] = SendState]
                  /\ step' = [step EXCEPT ![r] = "steer_sent"]
                  /\ UNCHANGED fifoOut
               \/ /\ sends' = [sends EXCEPT ![r] = @ + 1] \* child가 읽었다고 본다(최악)
                  /\ rstate' = [rstate EXCEPT ![r] = "uncertain"]
                  /\ fifoOut' = [fifoOut EXCEPT ![r] = TRUE]
                  /\ step' = [step EXCEPT ![r] = ""]
    /\ UNCHANGED <<kind, retried, originVars, sysVars, delVars>>

(* #markOrPark: 원장 쓰기가 던지면 uncertain(다시 보내지 않음). steer 뒤 턴이 *)
(* 끝났으면 turn_ended_after_steer로 uncertain.                             *)
LedgerFailState == IF BugReplayUncertain THEN "pending" ELSE "uncertain"

SteerRecord(r) ==
    LET o == OriginOf[r] IN
    /\ up /\ step[r] = "steer_sent"
    /\ step' = [step EXCEPT ![r] = ""]
    /\ IF turn[o] # "running"
          THEN /\ rstate' = [rstate EXCEPT ![r] = "uncertain"]
               /\ fifoOut' = [fifoOut EXCEPT ![r] = TRUE]
               /\ UNCHANGED <<kind, sends, steers>>
          ELSE \/ /\ rstate' = [rstate EXCEPT ![r] = "dispatched"]
                  /\ Folded(r)
                  /\ steers' = [steers EXCEPT ![o] = @ + 1]
               \/ /\ LedgerFaults
                  /\ rstate' = [rstate EXCEPT ![r] = LedgerFailState]
                  /\ fifoOut' = [fifoOut EXCEPT ![r] = ~BugReplayUncertain]
                  /\ UNCHANGED <<kind, sends, steers>>
    /\ UNCHANGED <<retried, turn, sysVars, delVars>>

(* 새 턴 경로(#startTurn → #openTurn): child를 띄우고 write-ahead 뒤 prompt를  *)
(* 보낸다. child가 받지 않은 실패는 dispatch_failed 공지(closed). child에 닿은  *)
(* 뒤 request_timeout으로 끝나면 행은 sending이므로 다시 보내지 않고 uncertain  *)
(* (prompt_timeout)으로 두고 child를 멈춘다(mailbox-sending.ts settleFailedSend). *)
(* 닿지 않은 timeout·not_started의 재시도는 sends가 그대로라 넣지 않았다.        *)
StartSend(r) ==
    /\ up /\ step[r] = "start"
    /\ \/ /\ sends' = [sends EXCEPT ![r] = @ + 1]
          /\ rstate' = [rstate EXCEPT ![r] = SendState]
          /\ step' = [step EXCEPT ![r] = "start_sent"]
          /\ UNCHANGED <<kind, fifoOut>>
       \/ /\ rstate' = [rstate EXCEPT ![r] = "closed"]
          /\ Folded(r)
          /\ step' = [step EXCEPT ![r] = ""]
       \/ /\ sends' = [sends EXCEPT ![r] = @ + 1]
          /\ IF BugTimeoutRetry
                THEN /\ rstate' = [rstate EXCEPT ![r] = SendState] \* 새 driver로 같은 dispatch를 다시 한다
                     /\ UNCHANGED <<kind, fifoOut, step>>
                ELSE /\ rstate' = [rstate EXCEPT ![r] = "uncertain"]
                     /\ fifoOut' = [fifoOut EXCEPT ![r] = TRUE]
                     /\ step' = [step EXCEPT ![r] = ""]
                     /\ UNCHANGED kind
    /\ UNCHANGED <<retried, originVars, sysVars, delVars>>

(* prompt가 받아진 뒤 원장 기록. 실패하면 child를 멈추고 uncertain.          *)
StartRecord(r) ==
    LET o == OriginOf[r] IN
    /\ up /\ step[r] = "start_sent"
    /\ step' = [step EXCEPT ![r] = ""]
    /\ \/ /\ rstate' = [rstate EXCEPT ![r] = "dispatched"]
          /\ Folded(r)
          /\ turn' = [turn EXCEPT ![o] = "running"]
          /\ steers' = [steers EXCEPT ![o] = 0]
       \/ /\ LedgerFaults
          /\ rstate' = [rstate EXCEPT ![r] = LedgerFailState]
          /\ UNCHANGED <<kind, sends, fifoOut, originVars>>
    /\ UNCHANGED <<retried, sysVars, delVars>>

(* omp final 도착: turn.finalArrived. 정리(#onFinal)는 직렬 체인에서 기다린다. *)
FinalArrives(o) ==
    /\ up /\ turn[o] = "running"
    /\ turn' = [turn EXCEPT ![o] = "final"]
    /\ UNCHANGED <<rowVars, steers, sysVars, delVars>>

(* #onFinal(답) 또는 #onExit(실패 공지): 이 턴의 dispatched 행을 닫는다.       *)
Settle(o) ==
    /\ up /\ turn[o] # "none" /\ ~Busy(o)
    /\ rstate' = [r \in Rows |-> IF OriginOf[r] = o /\ rstate[r] = "dispatched" THEN "closed" ELSE rstate[r]]
    /\ turn' = [turn EXCEPT ![o] = "none"]
    /\ steers' = [steers EXCEPT ![o] = 0]
    /\ UNCHANGED <<kind, sends, retried, fifoOut, step, sysVars, delVars>>

Freeze ==
    /\ ~frozen /\ freezes < 1
    /\ frozen' = TRUE /\ freezes' = freezes + 1
    /\ UNCHANGED <<rowVars, originVars, origin3, up, draining, restarts, fifoBroken, delVars>>

Unfreeze ==
    /\ frozen /\ frozen' = FALSE
    /\ UNCHANGED <<rowVars, originVars, origin3, freezes, up, draining, restarts, fifoBroken, delVars>>

(* 오너 명령 `/queue retry`(mailbox-commands.ts retryUncertain): uncertain을    *)
(* pending으로 돌리고 drain을 요청한다. 오너에게 "답이 두 번 나올 수 있다"고   *)
(* 알리는 명시적 재전송이라 sends를 새로 센다.                               *)
QueueRetry(r) ==
    /\ up /\ rstate[r] = "uncertain" /\ ~retried[r]
    /\ retried' = [retried EXCEPT ![r] = TRUE]
    /\ rstate' = [rstate EXCEPT ![r] = "pending"]
    /\ sends' = [sends EXCEPT ![r] = 0]
    /\ fifoOut' = [fifoOut EXCEPT ![r] = TRUE]
    /\ UNCHANGED <<kind, step, originVars, sysVars, delVars>>

(* 계획 재시작: drain 모드 → 턴이 다 끝나거나(busyTurns 0) cut 한도에서 끊고  *)
(* 종료 → 새 프로세스가 recoverDispatched 뒤 resumePending.                   *)
BeginDrain ==
    /\ up /\ ~draining /\ restarts < MaxRestarts
    /\ draining' = TRUE
    /\ UNCHANGED <<rowVars, originVars, origin3, frozen, freezes, up, restarts, fifoBroken, delVars>>

(* 프로세스 끝: drain cut은 턴이 끝나기를 기다리지 않으므로 prompt·steer를     *)
(* 보낸 뒤 장부 기록 전(start_sent·steer_sent)에도 끊는다. OOM·kill -9도 같은 *)
(* 자리에서 끊기므로 BeginDrain 바로 뒤의 Shutdown이 그 경우를 덮는다.          *)
Shutdown ==
    /\ up /\ draining
    /\ up' = FALSE /\ draining' = FALSE
    /\ step' = [r \in Rows |-> ""]
    /\ turn' = [o \in Origins |-> "none"]
    /\ steers' = [o \in Origins |-> 0]
    /\ UNCHANGED <<rstate, kind, sends, retried, fifoOut, origin3, frozen, freezes, restarts, fifoBroken, delVars>>

(* recoverDispatched: 죽은 프로세스의 dispatched 행은 답이나 끊김 공지 하나로  *)
(* 닫는다(closed). sending 행은 child에 닿았을 수 있으므로 cut 기록과 상관없이 *)
(* uncertain으로 둔다(settleDeadProcessRows). prompt는 다시 보내지 않는다.      *)
(* pump는 남은 inflight delivery를 recover로 pending(redelivered)에 돌린다.      *)
Boot ==
    /\ ~up
    /\ up' = TRUE /\ restarts' = restarts + 1
    /\ rstate' = [r \in Rows |-> CASE rstate[r] = "dispatched" -> "closed"
                                   [] rstate[r] = "sending" -> "uncertain"
                                   [] OTHER -> rstate[r]]
    /\ fifoOut' = [r \in Rows |-> fifoOut[r] \/ rstate[r] = "sending"]
    /\ dstate' = IF dstate = "inflight" \/ (BugRecoverConfirmed /\ dstate = "confirmed")
                    THEN "pending" ELSE dstate
    /\ UNCHANGED <<kind, sends, retried, step, originVars,
                   origin3, frozen, freezes, draining, fifoBroken, attempts, defFails, confirms>>

----------------------------------------------------------------------------
(* outbound delivery 하나 (store/transitions.ts transitionDelivery, channel/pump.ts).  *)
(* pump는 메일박스와 따로 돌고 inbound 변수와 공유하는 것이 없어, 두 쪽 동작은 *)
(* 순서를 바꿔도 결과가 같다. 얽히는 곳은 재시작(Shutdown·Boot)뿐이므로        *)
(* delivery 동작은 inbound 행이 하나도 들어오기 전에만, inbound 행은 delivery가 *)
(* 처음 모양(DIdle)일 때만 들어오게 해 두 쪽 상태를 곱하지 않고 더한다. 두 쪽  *)
(* 모두 재시작과의 모든 순서(drain 전·중·Boot 뒤)는 그대로 남는다.            *)
DReady == up /\ \A r \in Rows : rstate[r] = "none"
DUnchanged == UNCHANGED <<rowVars, originVars, sysVars>>

DClaim ==
    /\ DReady /\ dstate = "pending" /\ dstate' = "inflight"
    /\ UNCHANGED <<attempts, defFails, confirms>> /\ DUnchanged

DConfirm ==
    /\ DReady /\ dstate = "inflight" /\ dstate' = "confirmed" /\ confirms' = confirms + 1
    /\ UNCHANGED <<attempts, defFails>> /\ DUnchanged

DDefinitive ==
    /\ DReady /\ dstate = "inflight"
    /\ attempts' = attempts + 1 /\ defFails' = defFails + 1
    /\ dstate' = IF attempts + 1 >= MaxFailures THEN "expired" ELSE "pending"
    /\ UNCHANGED confirms /\ DUnchanged

DRateLimited ==
    /\ DReady /\ dstate = "inflight"
    /\ dstate' \in {"pending", "expired"} \* expired: 24h 신선도 창을 넘겼다
    /\ attempts' = IF BugRateLimitCounts THEN attempts + 1 ELSE attempts
    /\ UNCHANGED <<defFails, confirms>> /\ DUnchanged

DAmbiguous ==
    /\ DReady /\ dstate = "inflight" /\ dstate' = "failed_ambiguous"
    /\ UNCHANGED <<attempts, defFails, confirms>> /\ DUnchanged

DExpire ==
    /\ DReady /\ dstate = "pending" /\ dstate' = "expired"
    /\ UNCHANGED <<attempts, defFails, confirms>> /\ DUnchanged

DAck ==
    /\ DReady /\ dstate = "failed_ambiguous" /\ dstate' = "confirmed" /\ confirms' = confirms + 1
    /\ UNCHANGED <<attempts, defFails>> /\ DUnchanged

DResend ==
    /\ DReady /\ dstate = "failed_ambiguous" /\ dstate' = "pending"
    /\ UNCHANGED <<attempts, defFails, confirms>> /\ DUnchanged

Delivery == DClaim \/ DConfirm \/ DDefinitive \/ DRateLimited \/ DAmbiguous \/ DExpire \/ DAck \/ DResend

----------------------------------------------------------------------------
System ==
    \/ \E o \in Origins : DrainPass(o) \/ FinalArrives(o) \/ Settle(o)
    \/ \E r \in Rows : SteerSend(r) \/ SteerRecord(r) \/ StartSend(r) \/ StartRecord(r)
    \/ Shutdown \/ Boot \/ Unfreeze

Environment ==
    \/ \E r \in Rows : Arrive(r) \/ QueueRetry(r)
    \/ Freeze \/ BeginDrain \/ Delivery

Next == System \/ Environment

Fairness ==
    /\ \A o \in Origins : WF_vars(DrainPass(o)) /\ WF_vars(FinalArrives(o)) /\ WF_vars(Settle(o))
    /\ \A r \in Rows : WF_vars(SteerSend(r) \/ SteerRecord(r) \/ StartSend(r) \/ StartRecord(r))
    /\ WF_vars(Shutdown) /\ WF_vars(Boot) /\ WF_vars(Unfreeze)

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* 규칙 5개. 이름은 README.md 규칙 표와 같아야 한다(test/tla-mailbox.test.ts). *)

\* 1. inbound 행 하나는 omp 턴에 많아야 한 번 들어간다(오너의 `/queue retry`가 새로 센다).
DispatchAtMostOnce == \A r \in Rows : sends[r] <= 1

\* 2. pending 행은 결국 pending을 벗어난다 (dispatched·uncertain, 또는 그 뒤 상태).
NoLostRow == \A r \in Rows : rstate[r] = "pending" ~> rstate[r] \in LeftPending

\* 3. 한 origin에서 새 턴을 시작하는 일반 행은 받은 순서대로 시작한다 (fifoOut 행은 뺀다).
OriginFifo == ~fifoBroken

\* 4. 한 origin에는 동시에 턴이 하나뿐이다 (child를 띄우는 중도 센다).
SingleTurnPerOrigin ==
    \A o \in Origins : Cardinality(Starting(o)) + (IF turn[o] # "none" THEN 1 ELSE 0) <= 1

\* 5. outbound delivery는 많아야 한 번 성공으로 기록되고, rate_limited는 시도 횟수를 올리지 않는다.
DeliveryAtMostOnce == confirms <= 1 /\ attempts = defFails
=============================================================================
