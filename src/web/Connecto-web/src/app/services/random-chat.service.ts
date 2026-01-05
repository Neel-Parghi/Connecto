import { Injectable, OnDestroy } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { BehaviorSubject, Subject, shareReplay } from 'rxjs';
import CryptoJS from 'crypto-js';
import { v4 as uuidv4 } from 'uuid';
import { environment } from '../environments/environment.dev';
import { ImagePayload } from '../models/image-payload';

@Injectable({ providedIn: 'root' })
export class RandomChatSignalRService implements OnDestroy {

  // Public API for consumers
  public hubConnection!: signalR.HubConnection;

  // sessionKey used for encryption/decryption
  private sessionKey: string | null = null;

  // lightweight message cache (keeps history in memory)
  public messages: any[] = [];

  // Subjects (private) and exposed Observables (public)
  private connectionIdSub = new BehaviorSubject<string | null>(null);
  private messagesSub = new BehaviorSubject<any | null>(null);
  private sessionSub = new BehaviorSubject<any | null>(null);
  private waitingSub = new BehaviorSubject<string | null>(null);
  private skippedSub = new Subject<string>();
  private youSkippedSub = new Subject<string>();
  private activeUserCountSub = new Subject<number>();

  public typingState = new BehaviorSubject<boolean>(false);
  private typingTimeout: any = null;
  private typingCooldown = false;
  private typingStopTimer: any = null;

  public messages$ = this.messagesSub.asObservable();
  public connectionId$ = this.connectionIdSub.asObservable();
  public sessionUpdates$ = this.sessionSub.asObservable().pipe(shareReplay(1));
  public waiting$ = this.waitingSub.asObservable();
  public skippedEvents$ = this.skippedSub.asObservable();
  public youSkippedEvents$ = this.youSkippedSub.asObservable();
  public activeUserCountSub$ = this.activeUserCountSub.asObservable();

  // Unique id used as access token factory for SignalR. Kept original behavior.
  private readonly userId = uuidv4();

  // Media-related subjects
  private voiceNoteSubject = new Subject<any>();
  public voiceNote$ = this.voiceNoteSubject.asObservable();

  private imageSubject = new Subject<any>();
  public image$ = this.imageSubject.asObservable();

  private audioSubject = new Subject<any>();
  public audio$ = this.audioSubject.asObservable();

  private guestName!: string;

  constructor() {
    this.buildHubConnection();
    this.registerHandlers();
  }

  /**
   * Build hub connection.
   */
  private buildHubConnection(): void {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl(`${environment.apiBaseUrl}/chathub`, {
        accessTokenFactory: () => this.userId,
        withCredentials: true
      })
      .withAutomaticReconnect([0, 2000, 5000, 10000])
      .build();

    setInterval(() => {
      if (this.hubConnection.state === signalR.HubConnectionState.Connected)
        this.hubConnection.invoke("Ping").catch(() => { });
    }, 15000);
  }

  /**
   * Register all SignalR handlers. 
   */
  private registerHandlers(): void {

    // Active User count update
    this.hubConnection.on('ActiveUserCountUpdated', (count: number) => {
      this.activeUserCountSub.next(count);
    });

    // Receive a chat message.
    this.hubConnection.on('ReceiveMessage', (msg: any) => {
      if (!this.sessionKey) return;

      let decryptedText: string;

      try {
        decryptedText = CryptoJS.AES.decrypt(msg.text, this.sessionKey).toString(CryptoJS.enc.Utf8);
      } catch (e) {
        // If decryption fails, fall back to raw text.
        decryptedText = msg.text;
      }

      this.messagesSub.next({ ...msg, text: decryptedText });
    });

    // User Typing
    this.hubConnection.on('UserTyping', (payload: any) => {
      try {
        this.typingState.next(true);

        if (this.typingTimeout) {
          clearTimeout(this.typingTimeout);
        }
        this.typingTimeout = setTimeout(() => {
          this.typingState.next(false);
        }, 2000);
      } catch (err) {
        console.warn("[ChatService] UserTyping handler error", err);
      }

      this.hubConnection.on("UserTypingStopped", () => {
        this.typingState.next(false);
        if (this.typingTimeout) clearTimeout(this.typingTimeout);
      });
    });

    // Partner skipped
    this.hubConnection.on('PartnerSkipped', (msg: string) => {
      this.messages.push({ system: true, text: msg });
      this.skippedSub.next(msg);
    });

    // You skipped
    this.hubConnection.on('YouSkipped', (msg: string) => {
      this.messages.push({ system: true, text: msg });
      this.youSkippedSub.next(msg);
    });

    // Voice note incoming
    this.hubConnection.on('ReceiveVoiceNote', (msg: any) => {
      this.voiceNoteSubject.next(msg);
    });

    // Image incoming
    this.hubConnection.on('ReceiveImage', (payload: ImagePayload) => {
      let base64 = payload.base64;

      if (!base64.startsWith('data:image')) {
        base64 = 'data:image/png;base64,' + base64;
      }

      this.imageSubject.next({
        from: payload.from,
        userId: payload.userId,
        image: true,
        imageUrl: base64,
        timestamp: payload.timestamp || new Date().toISOString()
      });
    });

    // Incoming call (audio)
    this.hubConnection.on('IncomingCall', (payload: any) => {
      this.audioSubject.next({ from: payload.from });
    });
  }

  /**
   * Connect to hub and wire up connection lifecycle listeners.
   * Preserves existing behavior: when ReceiveConnectionId arrives we call RegisterUser
   * and then join chat.
   */
  public async connect(guestName: string): Promise<void> {
    this.guestName = guestName;

    // Ensure we re-register the handler in case connect() is called multiple times.
    this.hubConnection.off('ReceiveConnectionId');
    this.hubConnection.on('ReceiveConnectionId', async (connectionId: string) => {
      this.connectionIdSub.next(connectionId);
      try {
        await this.hubConnection.invoke('RegisterUser', this.guestName);
        await this.joinChat();
      } catch (err) {
        console.error('Error during ReceiveConnectionId handler:', err);
      }
    });

    // Session update handler
    this.hubConnection.off('SessionUpdate');
    this.hubConnection.on('SessionUpdate', (session: any) => {
      this.sessionSub.next(session);
      this.sessionKey = session.key;
      this.waitingSub.next(null);
    });

    // Waiting handler
    this.hubConnection.off('Waiting');
    this.hubConnection.on('Waiting', (msg: string) => {
      this.waitingSub.next(msg);
    });

    // Start the connection if not already started
    try {
      if (this.hubConnection.state === signalR.HubConnectionState.Disconnected) {
        await this.hubConnection.start();
      }
    } catch (err) {
      console.error('SignalR start error in connect():', err);
    }
  }

  /**
   * Instructs server to join chat.
   */
  public async joinChat(): Promise<void> {
    try {
      if (this.hubConnection.state === signalR.HubConnectionState.Connected)
        await this.hubConnection.invoke('JoinChat');
    } catch (err) {
      console.error('JoinChat error:', err);
    }
  }

  /**
   * Send a text message. Encryption preserved exactly.
   */
  public async sendMessage(sessionId: string, text: string): Promise<void> {
    if (!this.sessionKey) return;
    const encryptedText = CryptoJS.AES.encrypt(text, this.sessionKey).toString();
    try {
      if (this.hubConnection.state === signalR.HubConnectionState.Connected)
        await this.hubConnection.invoke('SendMessage', sessionId, encryptedText);
    } catch (err) {
      console.error('SendMessage error:', err);
    }
  }

  /**
   * Send image payload (base64).
   */
  public async sendImage(sessionId: string, base64: string, from: string): Promise<void> {
    if (!this.sessionKey) return;
    try {
      if (this.hubConnection.state === signalR.HubConnectionState.Connected)
        await this.hubConnection.invoke('SendImage', sessionId, from, base64);
    } catch (err) {
      console.error('Error while sending image', err);
    }
  }

  /**
   * Skip current chat.
   */
  public async skipChat(sessionId: string): Promise<void> {
    try {
      if (this.hubConnection && this.hubConnection.state === signalR.HubConnectionState.Connected) {
        await this.hubConnection.invoke('SkipChat', sessionId);
      }
    } catch (err) {
      console.error('SkipChat invoke error:', err);
    }
  }

  /**
   * Ask server for next chat. Ensures connection exists first.
   */
  public async nextChat(): Promise<any> {
    if (!this.hubConnection) return Promise.reject('No hub connection');

    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) {
      await this.ensureConnection();
    }
    if (this.hubConnection.state === signalR.HubConnectionState.Connected) {
      return this.hubConnection.invoke('NextChat');
    }
  }

  /**
   * Send voice note as base64 via FileReader.
   */
  public async sendVoiceNote(sessionId: string, blob: Blob): Promise<void> {
    if (!this.sessionKey) return;

    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64 = reader.result as string;
      try {
        if (this.hubConnection.state === signalR.HubConnectionState.Connected)
          await this.hubConnection.invoke('SendVoiceNote', sessionId, base64);
      } catch (err) {
        console.error('Error while sending Voicenote', err);
      }
    };
    reader.readAsDataURL(blob);
  }

  /**
   * Ensure hub connection is started.
   */
  private async ensureConnection(): Promise<void> {
    if (!this.hubConnection) return;
    if (this.hubConnection.state !== signalR.HubConnectionState.Connected) {
      try {
        if (this.hubConnection.state === signalR.HubConnectionState.Disconnected) {
          await this.hubConnection.start();
        }
      } catch (err) {
        console.error('Error starting connection in ensureConnection():', err);
      }
    }
  }

  /**
   * User Typing
   */
  public onUserTyped(fromUserId: string, toUserId: string) {
    if (!this.typingCooldown) {
      this.typingCooldown = true;

      if (this.hubConnection.state === signalR.HubConnectionState.Connected)
        this.hubConnection.invoke("SendTyping", fromUserId, toUserId);

      setTimeout(() => {
        this.typingCooldown = false;
      }, 2000);
    }

    if (this.typingStopTimer) clearTimeout(this.typingStopTimer);

    this.typingStopTimer = setTimeout(() => {
      if (this.hubConnection.state === signalR.HubConnectionState.Connected)
        this.hubConnection.invoke("SendTypingStopped", fromUserId, toUserId);
    }, 1000);
  }

  /**
   * Stop SignalR connection and optionally remove a user on the server.
   */
  public async stopConnection(userId?: string): Promise<void> {
    if (!this.hubConnection) return;

    if (userId) {
      await this.removeUser(userId);
    }

    try {
      await this.hubConnection.stop();
      console.log('SignalR Connection stopped');
    } catch (err) {
      console.error('Error while stopping connection: ', err);
    } finally {
      // Clear state so next subscription doesn't get stale data
      this.connectionIdSub.next(null);
      this.messagesSub.next(null);
      this.sessionSub.next(null);
      this.waitingSub.next(null);
      this.sessionKey = null;
      this.messages = [];
    }
  }

  /**
   * Tell server to remove user.
   */
  public async removeUser(userId: string): Promise<void> {
    if (this.hubConnection && this.hubConnection.state === signalR.HubConnectionState.Connected) {
      try {
        await this.hubConnection.invoke('RemoveUser', userId);
      } catch (err) {
        console.error('Error while removing user: ', err);
      }
    }
  }

  public ngOnDestroy(): void {
    void this.stopConnection();
  }
}
