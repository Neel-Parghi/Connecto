import { Injectable } from '@angular/core';
import { HubConnection } from '@microsoft/signalr';
import { BehaviorSubject } from 'rxjs';
import { ToastrService } from 'ngx-toastr';

type CallState = 'idle' | 'calling' | 'incoming' | 'in-call';

@Injectable({
  providedIn: 'root'
})
export class CallService {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  public hubConnection!: HubConnection;

  private currentUserId: string | null = null;
  private currentSessionId: string | null = null;
  private remoteUserId: string | null = null;

  public callState = new BehaviorSubject<CallState>('idle');
  callState$ = this.callState.asObservable();

  private remoteStreamSubject = new BehaviorSubject<MediaStream | null>(null);
  remoteStream$ = this.remoteStreamSubject.asObservable();

  private localStreamSubject = new BehaviorSubject<MediaStream | null>(null);
  localStream$ = this.localStreamSubject.asObservable();

  public incomingDisplayName: string | null = null;

  private pendingOffer: RTCSessionDescriptionInit | null = null;
  private pendingOfferFrom: string | null = null;
  private acceptPending = false;
  private pendingCandidates: any[] = [];

  constructor(private toastr: ToastrService) { }
  private handlersRegistered = false;

  init(hubConnection: HubConnection) {
    this.hubConnection = hubConnection;
    this.registerSignalRHandlers();
  }

  private registerSignalRHandlers() {

    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    this.hubConnection.on('IncomingCall', (payload: any) => {
      try {
        this.incomingDisplayName = payload?.From ?? payload?.from ?? null;
        this.currentSessionId = payload?.SessionId ?? payload?.sessionId ?? this.currentSessionId ?? null;
        this.callState.next('incoming');
      } catch (err) {
        console.warn('[CallService] IncomingCall handler error', err);
      }
    });

    this.hubConnection.on('ReceiveSignal', async (payload: any) => {
      try {
        if (!payload) return;

        const from = payload?.From ?? payload?.from ?? null;
        const type = (payload?.Type ?? payload?.type ?? '').toString();
        const data = payload?.Data ?? payload?.data ?? null;

        if (!from || !type) {
          console.warn('[CallService] malformed ReceiveSignal payload', payload);
          return;
        }

        if (!this.remoteUserId) this.remoteUserId = from;

        let parsed: any = null;
        if (typeof data === 'string') {
          try { parsed = JSON.parse(data); } catch { parsed = data; }
        } else {
          parsed = data;
        }

        switch (type.toLowerCase()) {
          case 'offer':
            await this.handleRemoteOfferReceived(parsed, from);
            break;
          case 'answer':
            await this.handleRemoteAnswer(parsed);
            break;
          case 'ice-candidate':
          case 'ice':
          case 'candidate':
            await this.handleRemoteIceCandidate(parsed);
            break;
          default:
            console.warn('[CallService] Unknown signal type:', type);
        }
      } catch (err) {
        console.error('[CallService] Error in ReceiveSignal handler', err);
      }
    });

    this.hubConnection.on('CallAccepted', (payload: any) => {
      this.callState.next('in-call');
    });

    this.hubConnection.on('CallRejected', (payload: any) => {
      this.clearPending();
      this.cleanup();
      this.callState.next('idle');
    });

    this.hubConnection.on('CallEnded', (payload: any) => {
      this.clearPending();
      this.cleanup();
      this.callState.next('idle');
    });
  }

  async startCall(sessionId: string, fromUserId: string, toUserId: string) {
    if (!this.hubConnection) throw new Error('Hub connection not initialized');

    this.currentSessionId = sessionId;
    this.currentUserId = fromUserId;
    this.remoteUserId = toUserId;

    this.callState.next('calling');
    await this.createPeerConnection();
    await this.ensureLocalStreamAttached();

    try {
      await this.hubConnection.invoke('StartCall', sessionId, fromUserId, toUserId);
    } catch (err) {
      console.warn('[CallService] StartCall invoke failed', err);
    }
    try {
      const offer = await this.peerConnection!.createOffer();
      await this.peerConnection!.setLocalDescription(offer);

      await this.hubConnection.invoke('SendSignal', this.currentSessionId, this.currentUserId, 'offer', JSON.stringify(offer));
    } catch (err) {
      console.error('[CallService] createOffer/send failed', err);
    }
  }

  async acceptCall(sessionId: string, myUserId: string, callerUserId: string) {
    if (!this.hubConnection) throw new Error('Hub connection not initialized');

    this.currentSessionId = sessionId;
    this.currentUserId = myUserId;
    this.remoteUserId = callerUserId;

    await this.createPeerConnection();
    await this.ensureLocalStreamAttached();

    try {
      await this.hubConnection.invoke('AcceptCall', sessionId, myUserId, callerUserId);
    } catch (err) {
      console.warn('[CallService] AcceptCall invoke failed', err);
    }

    this.acceptPending = true;

    if (this.pendingOffer) {
      await this.processPendingOffer();
    }

  }

  async rejectCall(sessionId: string, myUserId: string, callerUserId: string) {
    try {
      await this.hubConnection.invoke('RejectCall', sessionId, myUserId, callerUserId);
    } catch (err) {
      console.warn('[CallService] RejectCall invoke failed', err);
    } finally {
      this.clearPending();
      this.callState.next('idle');
      this.cleanup();
    }
  }

  async endCall(sessionId: string, myUserId: string, otherUserId: string) {
    try {
      if (this.hubConnection) {
        await this.hubConnection.invoke('EndCall', sessionId, myUserId, otherUserId);
      }
    } catch (err) {
      console.warn('[CallService] EndCall invoke failed', err);
    } finally {
      this.clearPending();
      this.callState.next('idle');
      this.cleanup();
    }
  }

  private async handleRemoteOfferReceived(offer: RTCSessionDescriptionInit, fromUserId: string) {
    try {
      // Auto-renegotiate if we are already in a call
      if (this.callState.value === 'in-call' && this.peerConnection) {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        if (this.currentSessionId && this.currentUserId) {
          await this.hubConnection.invoke('SendSignal', this.currentSessionId, this.currentUserId, 'answer', JSON.stringify(answer));
        }
        return;
      }

      this.pendingOffer = offer;
      this.pendingOfferFrom = fromUserId ?? this.pendingOfferFrom ?? null;
      this.remoteUserId = fromUserId ?? this.remoteUserId;

      if (this.acceptPending) {
        await this.processPendingOffer();
      } else {
        console.debug('[CallService] Offer received and stored; waiting for user to accept.');
      }
    } catch (err) {
      console.error('[CallService] handleRemoteOfferReceived error', err);
    }
  }

  private async processPendingOffer() {
    if (!this.pendingOffer) {
      return;
    }

    try {
      await this.createPeerConnection();
      await this.ensureLocalStreamAttached();

      await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(this.pendingOffer));

      if (this.pendingCandidates.length > 0) {
        for (const candidate of this.pendingCandidates) {
          await this.handleRemoteIceCandidate(candidate);
        }
        this.pendingCandidates = [];
      }

      const answer = await this.peerConnection!.createAnswer();
      await this.peerConnection!.setLocalDescription(answer);

      if (this.currentSessionId && this.currentUserId) {
        await this.hubConnection.invoke('SendSignal', this.currentSessionId, this.currentUserId, 'answer', JSON.stringify(answer));
      } else {
        console.warn('[CallService] Missing sessionId or currentUserId when sending answer');
      }

      this.callState.next('in-call');
    } catch (err) {
      console.error('[CallService] processPendingOffer error', err);
      this.cleanup();
      this.callState.next('idle');
    } finally {
      this.acceptPending = false;
      this.pendingOffer = null;
      this.pendingOfferFrom = null;
    }
  }

  private async handleRemoteAnswer(answer: any) {
    if (!this.peerConnection) return;

    if (this.peerConnection.signalingState !== 'have-local-offer') {
      console.warn('[CallService] Ignoring answer because state is', this.peerConnection.signalingState);
      return;
    }

    await this.peerConnection.setRemoteDescription(answer);
  }

  private async handleRemoteIceCandidate(candidateObj: any) {
    try {
      if (!this.peerConnection) {
        this.pendingCandidates.push(candidateObj);
        return;
      }

      const candidate = (candidateObj && candidateObj.candidate) ? candidateObj : candidateObj;
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        try {
          await this.peerConnection.addIceCandidate(candidate);
        } catch (e) {
          console.warn('[CallService] addIceCandidate failed twice', e);
        }
      }
    } catch (err) {
      console.error('[CallService] handleRemoteIceCandidate error', err);
    }
  }

  private async createPeerConnection() {
    if (this.peerConnection) return;

    const config: RTCConfiguration = {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] }
      ]
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.remoteStream = new MediaStream();
    this.remoteStreamSubject.next(this.remoteStream);

    this.peerConnection.ontrack = (event) => {
      try {
        if (event.streams && event.streams.length > 0) {
          event.streams[0].getTracks().forEach(t => this.remoteStream!.addTrack(t));
        } else if ((event as any).track) {
          this.remoteStream!.addTrack((event as any).track);
        }
        this.remoteStreamSubject.next(this.remoteStream);
      } catch (err) {
        console.warn('[CallService] ontrack handler error', err);
      }
    };

    this.peerConnection.onicecandidate = (event) => {
      try {
        if (event.candidate && this.currentSessionId && this.currentUserId && this.remoteUserId) {
          this.hubConnection.invoke('SendSignal', this.currentSessionId, this.currentUserId, 'ice-candidate', JSON.stringify(event.candidate))
            .catch((e: any) => console.warn('[CallService] Failed to send ICE candidate', e));
        }
      } catch (err) {
        console.warn('[CallService] onicecandidate handler error', err);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection) return;
      const state = this.peerConnection.connectionState;

      if (state === 'failed') {
        this.toastr.warning('Connection unstable, attempting to reconnect...', 'Weak Signal');
        void this.attemptReconnect();
      } else if (state === 'closed') {
        this.cleanup();
        this.callState.next('idle');
      }
    };
  }

  private async attemptReconnect() {
    if (!this.peerConnection || !this.currentSessionId || !this.currentUserId) return;

    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);

      await this.hubConnection.invoke('SendSignal', this.currentSessionId, this.currentUserId, 'offer', JSON.stringify(offer));
    } catch (err) {
      console.error('[CallService] ICE restart failed', err);
    }
  }

  private async ensureLocalStreamAttached() {
    if (!this.peerConnection) throw new Error('PeerConnection must be created before attaching local stream');

    if (!this.localStream) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.localStreamSubject.next(this.localStream);
      } catch (err) {
        console.error('[CallService] getUserMedia failed', err);
        throw err;
      }
    }

    try {
      const existingSenders = this.peerConnection.getSenders().map(s => s.track).filter(Boolean);
      for (const track of this.localStream.getTracks()) {
        if (!existingSenders.some(t => t && t.kind === track.kind && t.id === track.id)) {
          this.peerConnection.addTrack(track, this.localStream);
        }
      }
    } catch (err) {
      console.warn('[CallService] attaching local tracks failed', err);
    }
  }

  private cleanup() {
    try {
      if (this.peerConnection) {
        this.peerConnection.onicecandidate = null;
        this.peerConnection.ontrack = null;
        try { this.peerConnection.close(); } catch { }
        this.peerConnection = null;
      }

      if (this.localStream) {
        this.localStream.getTracks().forEach(t => { try { t.stop(); } catch { } });
        this.localStream = null;
        this.localStreamSubject.next(null);
      }

      if (this.remoteStream) {
        this.remoteStream.getTracks().forEach(t => { try { t.stop(); } catch { } });
        this.remoteStream = null;
        this.remoteStreamSubject.next(null);
      }

      this.currentSessionId = null;
      this.remoteUserId = null;
      this.currentUserId = null;
      this.incomingDisplayName = null;
      this.clearPending();
    } catch (err) {
      console.warn('[CallService] cleanup error', err);
    } finally {
      this.pendingCandidates = [];
    }
  }

  private clearPending() {
    this.pendingOffer = null;
    this.pendingOfferFrom = null;
    this.acceptPending = false;
    this.pendingCandidates = [];
  }

  get currentState() {
    return this.callState.value;
  }
}
