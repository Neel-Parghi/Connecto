import { Component } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.css'
})
export class NavbarComponent {

  showConfirm: boolean = false;

  constructor(private router: Router) { }

  navigateToHome() {
    if (['/'].includes(this.router.url)) {
      this.showConfirm = false;
      this.router.navigateByUrl('/guest');
    } else {
      this.showConfirm = true;
    }
  }

}
