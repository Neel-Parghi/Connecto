import { Component } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { NavbarComponent } from "../navbar/navbar.component";

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, NavbarComponent],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.css'
})
export class LayoutComponent {

  showFooter: boolean = true;

  constructor(private readonly router: Router){
    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) {
        const url = event.urlAfterRedirects;
        this.showFooter = ['/guest', '/'].some(path => url === path || url === '/' || (path !== '/' && url.startsWith(path)))

        if (url.includes('random-chat') || url.includes('chat')) {
          this.showFooter = false;
        }
      }
    })
  }
}
