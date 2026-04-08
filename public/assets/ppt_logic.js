/**
 * Smart Factory DBMS Presentation Logic
 * Navigation, Animations, and Real-time Effects
 */

document.addEventListener('DOMContentLoaded', () => {
    const slides = document.querySelectorAll('.slide');
    const totalSlides = slides.length;
    let currentSlide = 0;

    // Initialize Slides
    function updateSlides() {
        slides.forEach((slide, index) => {
            slide.classList.remove('active', 'prev', 'next');
            if (index === currentSlide) {
                slide.classList.add('active');
            } else if (index < currentSlide) {
                slide.classList.add('prev');
            } else {
                slide.classList.add('next');
            }
        });
        
        // Update Progress Bar
        const progress = ((currentSlide + 1) / totalSlides) * 100;
        const progressBar = document.querySelector('.ppt-progress-inner');
        if (progressBar) progressBar.style.width = `${progress}%`;

        // Update Slide Counter
        const counter = document.querySelector('.slide-counter span');
        if (counter) counter.innerText = `${currentSlide + 1} / ${totalSlides}`;
    }

    function nextSlide() {
        if (currentSlide < totalSlides - 1) {
            currentSlide++;
            updateSlides();
        }
    }

    function prevSlide() {
        if (currentSlide > 0) {
            currentSlide--;
            updateSlides();
        }
    }

    // Keyboard Navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
            nextSlide();
        } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
            prevSlide();
        }
    });

    // Touch Navigation
    let touchstartX = 0;
    let touchendX = 0;
    
    document.addEventListener('touchstart', e => {
        touchstartX = e.changedTouches[0].screenX;
    });

    document.addEventListener('touchend', e => {
        touchendX = e.changedTouches[0].screenX;
        if (touchstartX - touchendX > 70) nextSlide();
        if (touchendX - touchstartX > 70) prevSlide();
    });

    // Click to Next (Optional)
    // document.body.addEventListener('click', nextSlide);

    // Matrix Background Effect (Industrial Data Stream)
    const canvas = document.getElementById('ppt-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const alphabet = "0123456789 ABCDEF GHIJKL MNOPQR STUVWX YZ !@#$%^&*()_+";
        const fontSize = 14;
        const columns = canvas.width / fontSize;
        const drops = [];

        for (let x = 0; x < columns; x++) drops[x] = 1;

        function drawMatrix() {
            ctx.fillStyle = "rgba(4, 6, 13, 0.05)";
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = "rgba(0, 240, 255, 0.35)"; // Cyan Dim
            ctx.font = fontSize + "px 'Share Tech Mono'";

            for (let i = 0; i < drops.length; i++) {
                const text = alphabet.charAt(Math.floor(Math.random() * alphabet.length));
                ctx.fillText(text, i * fontSize, drops[i] * fontSize);

                if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                    drops[i] = 0;
                }
                drops[i]++;
            }
        }
        setInterval(drawMatrix, 33);
    }

    // Initialize
    updateSlides();
});
