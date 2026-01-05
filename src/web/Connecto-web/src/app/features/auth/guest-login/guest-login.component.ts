import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormGroup, FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-guest-login',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './guest-login.component.html',
  styleUrl: './guest-login.component.css'
})
export class GuestLoginComponent {
  form: FormGroup;

  constructor(private readonly fb: FormBuilder, private readonly router: Router) {
    this.form = this.fb.group({
      username: ['', Validators.required, Validators.maxLength(15)]
    });
  }

  startChat() {
    if (this.form.valid) {
      const username = this.form.value.username;
      localStorage.setItem('guest_username', username);
      this.router.navigate(['/random-chat'], {
        state: { username: username }
      });
    }
  }
}
