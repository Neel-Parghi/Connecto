import { CommonModule } from '@angular/common';
import { Component, ElementRef, HostListener, ViewChild, OnInit, OnDestroy, AfterViewInit, AfterViewChecked } from '@angular/core';
import { Subscription, Subject } from 'rxjs';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ToastrModule, ToastrService } from 'ngx-toastr';
import { ConfirmationPopupComponent } from '../../../shared/confirmation-popup/confirmation-popup.component';
import { CallService } from '../../../services/call.service';
import { RandomChatSignalRService } from '../../../services/random-chat.service';

@Component({
  selector: 'app-random-chat',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, ToastrModule, ConfirmationPopupComponent],
  templateUrl: './random-chat.component.html',
  styleUrls: ['./random-chat.component.css']
})
export class RandomChatComponent implements OnInit, AfterViewInit, AfterViewChecked, OnDestroy {

  pairedUserName: string | null = null;
  currentSessionId: string | null = null;
  myUser: { id: string; name: string } | null = null;
  pairedUser: { id: string; name: string } | null = null;

  messageControl: FormControl = new FormControl('', Validators.required);
  messages: Array<any> = [];
  isConnecting = true;
  currentUser = '';
  partnerUser: string | null = null;

  isDisconnected: boolean = false;
  isSkipped: boolean = false;
  showConfirm: boolean = false;
  currentState: 'chatting' | 'ended' | 'searching' | 'skipping' = 'searching';
  pendingNavigation: string | null = null;

  // Recording state
  isRecording = false;
  mediaStream: MediaStream | null = null;
  mediaRecorder: MediaRecorder | null = null;
  audioChunks: BlobPart[] = [];
  recordedBlob: Blob | null = null;
  audioUrl: string | null = null;
  recordStartTs = 0;
  private recordTimer: any = null;
  recordElapsed = 0;

  showAttachmentMenu = false;
  enlargedImageUrl: string | null = null;

  isTyping: boolean = false;
  activeUserCount : number = 0;

  // subscriptions / cleanup
  private subscriptions: Subscription[] = [];
  private destroy$ = new Subject<void>();

  @ViewChild('chatBody') chatBody!: ElementRef<HTMLElement>;
  @ViewChild('localAudio') localAudioRef!: ElementRef<HTMLAudioElement>;

  constructor(
    public readonly chatService: RandomChatSignalRService,
    private readonly toastr: ToastrService,
    private router: Router,
    public callService: CallService
  ) {
    const nav = this.router.getCurrentNavigation();
    this.currentUser = nav?.extras.state?.['username'] || '';
  }

  ngOnInit(): void {
    this.initFromLocalStorage();
    this.initCallServiceIfReady();
    this.initSessionSubscriptions();
    this.initMessageHandlers();
    this.initMediaSubscriptions();
    this.initCallHandlers();
    this.handleReloadFlow();
  }

  ngAfterViewInit(): void {
    const s = this.callService.localStream$.subscribe(stream => {
      if (this.localAudioRef?.nativeElement && stream) {
        this.localAudioRef.nativeElement.srcObject = stream;
      }
    });
    this.subscriptions.push(s);
  }

  ngAfterViewChecked(): void {
    // Keep chat scrolled to bottom once view updates
    if (this.chatBody) {
      try {
        this.chatBody.nativeElement.scrollTop = this.chatBody.nativeElement.scrollHeight;
      } catch (e) {
      }
    }
  }

  // --------------------------- Host Listeners ---------------------------
  @HostListener('window:beforeunload')
  onBeforeUnload() {
    if (this.currentSessionId) {
      void this.chatService.skipChat(this.currentSessionId);
    }
    localStorage.setItem('wasReload', 'true');
  }

  @HostListener('document:click', ['$event'])
  handleOutsideClick(event: Event) {
    const target = event.target as HTMLElement;
    if (!target.closest('.attachment-wrapper')) {
      this.closeAttachmentMenu();
    }
  }

  // --------------------------- Initialization helpers ---------------------------
  private initFromLocalStorage(): void {
    const username = localStorage.getItem('guest_username');
    if (username) {
      this.chatService.connect(username).catch(err => {
        console.error('Error connecting to chat service:', err);
      });
    }
  }

  private initCallServiceIfReady(): void {
    if (this.chatService.hubConnection) {
      this.callService.init(this.chatService.hubConnection);
    }
  }

  private initSessionSubscriptions(): void {
    // Keep a single subscription for session updates
    const s = this.chatService.sessionUpdates$.subscribe(session => {
      if (session) {
        this.currentSessionId = session.sessionId;
        this.pairedUserName = session.partner?.name || null;
        this.myUser = session.me || null;
        this.pairedUser = session.partner || null;
        this.messages = [];
        // If we have a partner name, we consider ourselves chatting
        if (this.pairedUserName) {
          this.currentState = 'chatting';
          this.toastr.success('You are connected to ' + this.pairedUser?.name)
        }
      } else {
        this.currentSessionId = null;
        this.myUser = null;
        this.pairedUser = null;
        this.messages = [];
      }
    });
    this.subscriptions.push(s);
  }

  private initMessageHandlers(): void {
    const s = this.chatService.messages$.subscribe(msg => {
      if (!msg) return;

      if (msg.type === 'connected') {
        this.isConnecting = false;
        this.currentState = 'chatting';
      }

      if (msg.system) {
        this.messages.push({ system: true, text: msg.text });

        if (msg.text.includes('left')) {
          this.currentState = 'ended';
          this.toastr.warning(msg.text, 'Notification', { positionClass: 'toast-top-right' });
        }
      } else {
        this.currentState = 'chatting';
        this.messages.push({ userId: msg.userId, text: msg.text, from: msg.from, time: msg.timestamp });
      }
    });
    this.subscriptions.push(s);

    const skippedEvents = this.chatService.skippedEvents$.subscribe(msg => {
      this.messages.push({ system: true, text: msg });
      this.currentState = 'ended';
      this.toastr.warning(msg, 'Chat ended', { positionClass: 'toast-top-right' });
      this.isDisconnected = true;
      this.isSkipped = true;
    });
    this.subscriptions.push(skippedEvents);

    const currentUserSkippedEvents = this.chatService.youSkippedEvents$.subscribe(msg => {
      this.messages.push({ system: true, text: msg });
      this.currentState = 'ended';
      this.toastr.warning(msg, '', { positionClass: 'toast-top-right' });
      this.isDisconnected = true;
      this.isSkipped = true;
    });
    this.subscriptions.push(currentUserSkippedEvents);

    const waiting = this.chatService.waiting$.subscribe(msg => {
      if (msg) {
        this.pairedUserName = null;
        this.currentState = 'searching';
        this.messages = [];
        this.toastr.info(msg, 'Searching...', { positionClass: 'toast-top-right' });
      }
    });
    this.subscriptions.push(waiting);

    const voiceNote = this.chatService.voiceNote$.subscribe(msg => {
      if (!msg) return;
      this.messages.push({ voice: true, userId: msg.userId, from: msg.from, audioUrl: msg.audio });
    });
    this.subscriptions.push(voiceNote);

    const image = this.chatService.image$.subscribe(msg => {
      this.messages.push({ from: msg.from, userId: msg.userId, image: true, imageUrl: msg.imageUrl });
    });
    this.subscriptions.push(image);

    const audio = this.chatService.audio$.subscribe(msg => {
      this.messages.push({ from: msg.from, text: 'Incoming call', call: true });
    });
    this.subscriptions.push(audio);

    this.chatService.typingState.subscribe(isTyping => {
      this.isTyping = isTyping;
    });

    this.chatService.activeUserCountSub$.subscribe(count => {
      this.activeUserCount = count;
    })
  }

  private initMediaSubscriptions(): void {
    const localStream = this.callService.localStream$.subscribe(stream => {
      if (stream && this.localAudioRef?.nativeElement) {
        this.localAudioRef.nativeElement.srcObject = stream;
      }
    });
    this.subscriptions.push(localStream);

    const remoteStream = this.callService.remoteStream$.subscribe(stream => {
      if (stream) {
        const el = document.getElementById('remoteAudio') as HTMLAudioElement | null;
        if (el) el.srcObject = stream;
      }
    });
    this.subscriptions.push(remoteStream);
  }

  private initCallHandlers(): void {
    // Attach call lifecycle handlers
    try {
      this.callService.hubConnection.on('CallAccepted', () => {
        this.callService.callState.next('in-call');
        this.messages.push({ system: true, text: 'Call accepted' });
      });

      this.callService.hubConnection.on('CallEnded', () => {
        this.callService.callState.next('idle');
        this.messages.push({ system: true, text: 'Call ended' });
      });

      this.callService.hubConnection.on('CallRejected', () => {
        this.callService.callState.next('idle');
        this.messages.push({ system: true, text: 'Call rejected' });
      });
    } catch (e) {
      // hubConnection may not be ready yet;
    }
  }

  private handleReloadFlow(): void {
    if (localStorage.getItem('wasReload') === 'true') {
      if (this.currentSessionId) {
        this.skipChat();
      }
      this.findNextUser();
      localStorage.removeItem('wasReload');
    }
  }

  async toggleCall() {
    const state = this.callService.currentState;
    if (state === 'idle') {
      try {
        await this.callService.startCall(this.currentSessionId!, this.myUser?.id!, this.pairedUser?.id!);
        this.messages.push({ system: true, text: 'calling...' });
      } catch (err) {
        console.error('startCall failed', err);
      }
    } else {
      await this.callService.endCall(this.currentSessionId!, this.myUser?.id!, this.pairedUser?.id!);
    }
  }

  acceptCall() {
    this.callService.acceptCall(this.currentSessionId!, this.myUser?.id!, this.pairedUser?.id!)
      .catch(err => console.error('acceptCall error', err));
  }

  rejectCall() {
    this.callService.callState.next('idle');
    this.callService.hubConnection.invoke('RejectCall', this.currentSessionId, this.myUser?.id!, this.pairedUser?.id);
  }

  // --------------------------- Recording methods ---------------------------
  async toggleRecording(): Promise<void> {
    if (!this.isRecording) {
      await this.startRecording();
    } else {
      await this.stopRecording();
    }
  }

  async startRecording(): Promise<void> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('Browser does not support getUserMedia');
      return;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new (window as any).MediaRecorder(this.mediaStream);
      this.audioChunks = [];

      if (this.mediaRecorder) {
        this.mediaRecorder.ondataavailable = (e: any) => {
          if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
        };

        this.mediaRecorder.onstop = () => {
          this.recordedBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
          this.audioUrl = URL.createObjectURL(this.recordedBlob);
        };

        this.mediaRecorder.start();
      }

      this.isRecording = true;
      this.recordStartTs = Date.now();
      this.startTimer();
    } catch (err) {
      console.error('Error starting audio recording:', err);
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.isRecording) return;

    this.isRecording = false;

    try {
      this.mediaRecorder!.onstop = null;
      this.mediaRecorder?.stop();

      await new Promise(res => setTimeout(res, 50));

      const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
      this.audioChunks = [];

      if (this.currentSessionId) {
        try {
          await this.chatService.sendVoiceNote(this.currentSessionId, blob);
        } catch (err) {
          console.error('Failed to send voice note over SignalR', err);
        }
      }

      if (this.mediaStream) {
        this.mediaStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (e) { } });
        this.mediaStream = null;
      }

      if (this.audioUrl) {
        URL.revokeObjectURL(this.audioUrl);
        this.audioUrl = null;
      }

      this.recordedBlob = null;
      this.recordElapsed = 0;
    } catch (e) {
      console.error('Error stopping recording', e);
    } finally {
      this.stopTimer();
    }
  }

  private startTimer(): void {
    this.recordElapsed = 0;
    this.recordTimer = setInterval(() => {
      this.recordElapsed = Date.now() - this.recordStartTs;
    }, 250);
  }

  private stopTimer(): void {
    if (this.recordTimer) {
      clearInterval(this.recordTimer);
      this.recordTimer = null;
    }
  }

  discardRecording(): void {
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.recordedBlob = null;
    this.audioUrl = null;
    this.audioChunks = [];
    this.recordElapsed = 0;
  }

  // --------------------------- Attachments ---------------------------
  onImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      let base64 = reader.result as string;
      if (!base64.startsWith('data:image')) base64 = 'data:image/png;base64,' + base64;
      void this.chatService.sendImage(this.currentSessionId!, base64, this.myUser?.id!);
    };
    reader.readAsDataURL(file);
    this.closeAttachmentMenu();
  }

  toggleAttachmentMenu(): void {
    this.showAttachmentMenu = !this.showAttachmentMenu;
  }

  closeAttachmentMenu(): void {
    this.showAttachmentMenu = false;
  }

  openImage(url: string): void {
    this.enlargedImageUrl = url;
    document.body.style.overflow = 'hidden';
  }

  closeImage(): void {
    this.enlargedImageUrl = null;
    document.body.style.overflow = '';
  }

  getCleanUsername(name: string | null): string | undefined {
    return name?.split('%%')[0];
  }

  // --------------------------- Messaging ---------------------------
  sendMessage(): void {
    const text = this.messageControl.value?.trim();
    if (this.currentSessionId && text) {
      void this.chatService.sendMessage(this.currentSessionId, text);
      this.messageControl.reset();
    }
  }

  skipChat(): void {
    this.currentState = 'skipping';
    void this.chatService.skipChat(this.currentSessionId!);
    this.partnerUser = null;
    this.currentState = 'ended';
  }

  findNextUser(): void {
    this.currentState = 'searching';
    void this.chatService.nextChat();
  }

  changeUsername(): void {
    this.attemptNavigation('/');
  }

  private attemptNavigation(url: string): void {
    if (this.currentState === 'chatting') {
      this.pendingNavigation = url;
      this.showConfirm = true;
    } else {
      this.router.navigate([url]);
    }
  }

  handleConfirm(result: boolean): void {
    this.showConfirm = false;

    if (result) {
      void this.ngOnDestroy();
      if (this.pendingNavigation) {
        this.router.navigate([this.pendingNavigation]);
        this.pendingNavigation = null;
      }
    } else {
      this.pendingNavigation = null;
    }
  }

  onInputKey(e: KeyboardEvent) {
    const key = e.key;

    if (key === "Enter") return;

    const allowed =
      key.length === 1 ||
      key === "Backspace" ||
      key === "Space";

    if (!allowed) return;

    this.chatService.onUserTyped(this.myUser?.id!, this.pairedUser?.id!);
  }

  // --------------------------- Cleanup ---------------------------
  async ngOnDestroy(): Promise<void> {
    try {
      if (this.currentSessionId) {
        await this.chatService.skipChat(this.currentSessionId);
      }
    } catch (err) {

    } finally {
      // unsubscribe from all subscriptions
      this.subscriptions.forEach(sub => sub.unsubscribe());
      this.destroy$.next();
      this.destroy$.complete();

      // stop connection
      void this.chatService.stopConnection();
    }
  }
}