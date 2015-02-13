options noxwait;
DATA _null_;
answer='n';
if upcase(answer)='y' then 
do;
x '"C:\Program Files\R\R-3.0.2\bin\i386\R.exe" CMD BATCH --vanila --slave "U:\gskcp\sourceFile.R"';
end;
run;


proc import datafile="U:\gskcp\quantile.csv"
     out=shoes
     dbms=csv
     replace;
     getnames=no;
run;
PROC PRINT;
RUN;
