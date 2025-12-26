/**
 * Stats_X Documentation - Main JavaScript
 * Sistema semplice: clicca sidebar → mostra sezione
 */

document.addEventListener('DOMContentLoaded', function() {
    initNavigation();
    initMobileMenu();
    handleInitialHash();
});

/**
 * Navigazione Sidebar → Contenuto
 */
function initNavigation() {
    // Trova tutti i link con data-section
    const navLinks = document.querySelectorAll('[data-section]');
    const sections = document.querySelectorAll('.tutorial-section');
    
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('data-section');
            
            // Rimuovi active da tutti i link
            navLinks.forEach(l => l.classList.remove('active'));
            // Aggiungi active al link cliccato
            this.classList.add('active');
            
            // Nascondi tutte le sezioni
            sections.forEach(section => {
                section.classList.remove('active');
            });
            
            // Mostra la sezione target
            const targetSection = document.getElementById(targetId);
            if (targetSection) {
                targetSection.classList.add('active');
                // Scroll al top del contenuto
                document.querySelector('.content').scrollTop = 0;
            }
            
            // Aggiorna URL (opzionale)
            history.pushState(null, null, '#' + targetId);
            
            // Chiudi menu mobile se aperto
            closeMobileMenu();
        });
    });
}

/**
 * Gestisce l'hash iniziale nell'URL
 */
function handleInitialHash() {
    const hash = window.location.hash.substring(1);
    
    if (hash) {
        const targetLink = document.querySelector(`[data-section="${hash}"]`);
        const targetSection = document.getElementById(hash);
        
        if (targetLink && targetSection) {
            // Rimuovi active da tutti
            document.querySelectorAll('[data-section]').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.tutorial-section').forEach(s => s.classList.remove('active'));
            
            // Attiva quelli giusti
            targetLink.classList.add('active');
            targetSection.classList.add('active');
        }
    }
}

/**
 * Menu Mobile
 */
function initMobileMenu() {
    const menuToggle = document.querySelector('.mobile-menu-toggle');
    const sidebar = document.querySelector('.sidebar');
    
    if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', function() {
            sidebar.classList.toggle('open');
        });
    }
}

function closeMobileMenu() {
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        sidebar.classList.remove('open');
    }
}
